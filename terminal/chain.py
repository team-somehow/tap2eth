"""The terminal's own small piece of the backend: it reads the chain itself.

On a tap the terminal finds the card's wallet, checks it can pay (registered, not frozen, within its
limits, enough balance) and builds the payment hash the card signs, all straight from the chain. Only
then does it go to the relayer, once, with the hash and the card's signature. A payment that would
fail is declined on the spot instead of after the customer approves it on their phone.

The relayer recomputes the hash with its own merchant and token addresses and rejects any mismatch, and
the wallet contract checks everything again on chain, so the terminal can't move money anywhere else.

Plain Python only (the Pi has no web3 libraries): Keccak-256, the little ABI encoding needed, and
JSON-RPC over urllib.
"""
import http.client
import json
import threading
import time
import urllib.parse
from decimal import Decimal, InvalidOperation

DEFAULT_RPC = "https://rpc.ankr.com/whitechain_testnet"
MAX_BATCH = 10  # Ankr refuses larger JSON-RPC batches (HTTP 413)
KIND_CARD = 0

# ------------------------------------------------------------------------------- Keccak-256 (Ethereum's hash)

_RC = (0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
       0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
       0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
       0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
       0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
       0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008)
_ROT = ((0, 36, 3, 41, 18), (1, 44, 10, 45, 2), (62, 6, 43, 15, 61), (28, 55, 25, 21, 56), (27, 20, 39, 8, 14))
_M = (1 << 64) - 1


def _rol(v, n):
    return ((v << n) | (v >> (64 - n))) & _M if n else v


def _permute(a):
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        a = [[b[x][y] ^ (~b[(x + 1) % 5][y] & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data):
    """Keccak-256 as Ethereum uses it (not hashlib's sha3_256, which pads differently)."""
    rate = 136
    msg = bytearray(data) + b"\x01"
    msg += b"\x00" * (-len(msg) % rate)
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(msg[off + 8 * i: off + 8 * i + 8], "little")
        a = _permute(a)
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


# ------------------------------------------------------------------------------- ABI

def _u(n):
    return int(n).to_bytes(32, "big")


def _a(addr):
    return bytes.fromhex(addr[2:].rjust(64, "0"))


def _selector(signature):
    return keccak256(signature.encode())[:4]


def _word(b, i=0):
    return int.from_bytes(b[32 * i: 32 * i + 32], "big")


def _dyn_bytes(b, offset):
    n = int.from_bytes(b[offset: offset + 32], "big")
    return b[offset + 32: offset + 32 + n]


def payment_hash(chain_id, wallet, token, merchant, amount, nonce, expiry):
    """Same as the wallet's paymentHash(): keccak256(abi.encode("TAP2ETH_V2_PAY", chainid, wallet, token, merchant, amount, nonce, expiry))."""
    tag = b"TAP2ETH_V2_PAY"
    head = _u(8 * 32) + _u(chain_id) + _a(wallet) + _a(token) + _a(merchant) + _u(amount) + _u(nonce) + _u(expiry)
    tail = _u(len(tag)) + tag.ljust(32, b"\x00")
    return keccak256(head + tail)


SEL = {name: _selector(sig) for name, sig in {
    "walletOf": "walletOf(bytes32)", "frozen": "frozen()", "threshold": "threshold()", "softLimit": "softLimit()",
    "softCardOnly": "softCardOnly()", "perTxLimit": "perTxLimit()", "dailyLimit": "dailyLimit()",
    "spentToday": "spentToday()", "spentDay": "spentDay()", "nonce": "nonce()", "signerCount": "signerCount()",
    "getSigner": "getSigner(uint256)", "balanceOf": "balanceOf(address)",
}.items()}


# ------------------------------------------------------------------------------- errors

class Declined(Exception):
    """The payment can't go through (frozen, over a limit, no money). Tell the customer now."""


class EdgeDown(Exception):
    """The terminal couldn't do its own checks (chain unreachable, no config). Fall back to the relayer."""


# ------------------------------------------------------------------------------- the edge

def _eth_call(to, data):
    return ("eth_call", [{"to": to, "data": "0x" + data.hex()}, "latest"])


class Edge:
    def __init__(self, rpc, config):
        """config comes from the relayer's /api/terminal/config: chainId, factory, token, decimals, merchant, ttl."""
        u = urllib.parse.urlsplit(rpc)
        self.rpc, self.host, self.https = rpc, u.netloc, u.scheme == "https"
        self.path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        self.chain_id = int(config["chainId"])
        self.factory, self.token, self.merchant = config["factory"], config["token"], config["merchant"]
        self.decimals, self.ttl = int(config["decimals"]), int(config["ttl"])
        self.cards = {}  # keccak(card modulus) -> (wallet, signer id): a card's wallet doesn't change
        self.conn, self.lock = None, threading.Lock()
        got = int(self._batch([("eth_chainId", [])])[0], 16)
        if got != self.chain_id:
            raise EdgeDown(f"RPC is chain {got}, the relayer uses {self.chain_id}")
        threading.Thread(target=self._keep_warm, daemon=True).start()

    # One kept-alive connection, and every tap's reads in one batched request: a new HTTPS connection
    # costs more than the reads themselves.
    def _send(self, payload):
        body = json.dumps(payload)
        with self.lock:
            for attempt in (1, 2):  # a kept-alive connection may have been closed by the server: retry once
                try:
                    if self.conn is None:
                        cls = http.client.HTTPSConnection if self.https else http.client.HTTPConnection
                        self.conn = cls(self.host, timeout=8)
                    self.conn.request("POST", self.path, body, {"content-type": "application/json"})
                    r = self.conn.getresponse()
                    data = r.read()
                    if r.status != 200:
                        raise EdgeDown(f"chain answered HTTP {r.status}")
                    return json.loads(data)
                except (http.client.HTTPException, OSError, ValueError) as e:
                    if self.conn:
                        self.conn.close()
                    self.conn = None
                    if attempt == 2:
                        raise EdgeDown(f"chain unreachable: {e}")

    def _batch(self, calls):
        out = []
        for start in range(0, len(calls), MAX_BATCH):
            chunk = calls[start:start + MAX_BATCH]
            j = self._send([{"jsonrpc": "2.0", "id": i, "method": m, "params": p} for i, (m, p) in enumerate(chunk)])
            if not isinstance(j, list):
                raise EdgeDown(f"chain error: {j.get('error') if isinstance(j, dict) else j}")
            got = [None] * len(chunk)
            for x in j:
                if "error" in x:
                    raise EdgeDown(f"chain error: {x['error'].get('message')}")
                got[x["id"]] = x["result"]
            out += got
        return out

    def _keep_warm(self):
        while True:
            time.sleep(25)
            try:
                self._batch([("eth_blockNumber", [])])
            except EdgeDown:
                pass

    @staticmethod
    def _bytes(result):
        return bytes.fromhex(result[2:])

    def _card(self, modulus):
        key = keccak256(modulus)
        if key in self.cards:
            return self.cards[key]
        wallet = "0x" + self._bytes(self._batch([_eth_call(self.factory, SEL["walletOf"] + key)])[0])[12:32].hex()
        if int(wallet, 16) == 0:
            raise Declined("This card isn't linked to a Tap2ETH wallet yet. (card not registered)")
        n = _word(self._bytes(self._batch([_eth_call(wallet, SEL["signerCount"])])[0]))
        signers = self._batch([_eth_call(wallet, SEL["getSigner"] + _u(i)) for i in range(n)]) if n else []
        for i, raw in enumerate(signers):
            s = self._bytes(raw)
            kind, active, a = _word(s, 0), _word(s, 1), _dyn_bytes(s, _word(s, 2))
            if kind == KIND_CARD and active and keccak256(a) == key:
                self.cards[key] = (wallet, i)
                return wallet, i
        raise Declined("This card isn't linked to a Tap2ETH wallet yet. (card not registered)")

    def units(self, amount):
        try:
            v = Decimal(str(amount)) * (Decimal(10) ** self.decimals)
        except InvalidOperation:
            raise Declined("Enter a valid amount.")
        if v <= 0 or v != v.to_integral_value():
            raise Declined("Enter a valid amount.")
        return int(v)

    def prepare(self, modulus, amount):
        """Check the payment and build the hash for the card. Raises Declined or EdgeDown."""
        t0 = time.monotonic()
        value = self.units(amount)
        wallet, card_id = self._card(modulus)
        names = ("frozen", "threshold", "softLimit", "softCardOnly", "perTxLimit", "dailyLimit", "spentToday", "spentDay", "nonce")
        calls = [_eth_call(wallet, SEL[n]) for n in names]
        calls.append(_eth_call(self.token, SEL["balanceOf"] + _a(wallet)))
        *reads, balance_raw = self._batch(calls)  # 10 reads: one request
        v = dict(zip(names, (_word(self._bytes(r)) for r in reads)))
        balance = _word(self._bytes(balance_raw))
        now = int(time.time())  # the Pi's clock is NTP-synced; the relayer and the contract check expiry again
        spent = v["spentToday"] if v["spentDay"] == now // 86400 else 0

        if v["frozen"]:
            raise Declined("IsFrozen")
        if value > v["perTxLimit"] or spent + value > v["dailyLimit"]:
            raise Declined("OverLimit")
        if balance < value:
            raise Declined("InsufficientBalance")
        soft = v["softLimit"] > 0 and value <= v["softLimit"]
        if not soft and v["threshold"] > 2:
            raise Declined(f"This wallet needs {v['threshold']} signatures; the terminal supports 2 for now.")

        expiry = now + self.ttl
        h = payment_hash(self.chain_id, wallet, self.token, self.merchant, value, v["nonce"], expiry)
        return {"wallet": wallet, "cardId": card_id, "nonce": v["nonce"], "expiry": expiry, "hash": "0x" + h.hex(),
                "challenge": h[:4].hex(), "ms": round((time.monotonic() - t0) * 1000)}

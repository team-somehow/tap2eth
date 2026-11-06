// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {SHA1} from "../SHA1.sol";

/// @notice Parameters for creating a wallet. Shared by the factory and the wallet so both hash them the same way.
struct InitParams {
    bytes cardModulus; // first card: RSA modulus
    bytes cardExponent; // first card: RSA exponent (minimal big-endian, usually 0x03)
    bytes32 phoneX; // first phone: P-256 public key
    bytes32 phoneY;
    uint256 perTxLimit;
    uint256 dailyLimit;
    uint256 recoveryDelay; // seconds a card-replacement proposal must wait (and can be cancelled)
}

/// @notice Signature checks shared by the wallet.
library TapSig {
    /// @dev WebAuthn assertion produced by a phone passkey.
    struct PhoneSig {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 challengeIndex; // index of `"challenge":"` in clientDataJSON
        uint256 typeIndex; // index of `"type":"webauthn.get"` in clientDataJSON
        bytes32 r;
        bytes32 s;
    }

    function createHash(address wallet, InitParams calldata p) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                "TAP2ETH_V2_CREATE",
                block.chainid,
                wallet,
                keccak256(p.cardModulus),
                keccak256(p.cardExponent),
                p.phoneX,
                p.phoneY,
                p.perTxLimit,
                p.dailyLimit,
                p.recoveryDelay
            )
        );
    }

    /// @dev EMV DDA signature check (ISO/IEC 9796-2 scheme 1, SHA-1). The card signs only 4 bytes of our hash.
    function verifyRsa(bytes memory n, bytes memory e, bytes4 challenge, bytes memory sig)
        internal
        view
        returns (bool)
    {
        uint256 len = n.length;
        if (sig.length != len || len < 64) return false;

        (bool ok, bytes memory m) = address(0x05).staticcall(abi.encodePacked(len, e.length, len, sig, e, n));
        if (!ok || m.length != len) return false;

        // Recovered block: 6A | 05 | hashAlg | Ldd | dynamic data | BB.. | SHA-1 (20) | BC
        if (m[0] != 0x6A || m[1] != 0x05 || m[len - 1] != 0xBC) return false;

        uint256 bodyLen = len - 22;
        bytes memory input = new bytes(bodyLen + 4);
        for (uint256 i = 0; i < bodyLen; i++) {
            input[i] = m[i + 1];
        }
        input[bodyLen] = challenge[0];
        input[bodyLen + 1] = challenge[1];
        input[bodyLen + 2] = challenge[2];
        input[bodyLen + 3] = challenge[3];

        bytes20 expected;
        assembly {
            expected := mload(add(add(m, 32), sub(len, 21)))
        }
        return SHA1.sha1(input) == expected;
    }

    /// @dev WebAuthn check: clientDataJSON carries base64url(h) as challenge, type webauthn.get, user present + verified.
    function verifyWebAuthn(bytes32 h, PhoneSig memory ps, bytes32 x, bytes32 y) internal view returns (bool) {
        bytes memory cd = bytes(ps.clientDataJSON);
        bytes memory expectedChallenge =
            bytes(string.concat('"challenge":"', Base64.encodeURL(abi.encodePacked(h)), '"'));
        if (!_contains(cd, ps.challengeIndex, expectedChallenge)) return false;
        if (!_contains(cd, ps.typeIndex, bytes('"type":"webauthn.get"'))) return false;

        bytes memory ad = ps.authenticatorData;
        if (ad.length < 37) return false;
        uint8 flags = uint8(ad[32]);
        if (flags & 0x01 == 0 || flags & 0x04 == 0) return false; // UP and UV

        bytes32 digest = sha256(abi.encodePacked(ad, sha256(cd)));
        return P256.verify(digest, ps.r, ps.s, x, y);
    }

    function _contains(bytes memory hay, uint256 at, bytes memory needle) private pure returns (bool) {
        if (at + needle.length > hay.length) return false;
        for (uint256 i = 0; i < needle.length; i++) {
            if (hay[at + i] != needle[i]) return false;
        }
        return true;
    }
}

interface ITap2EthFactoryV2 {
    function link(bytes32 cardKeyHash) external;
    function unlink(bytes32 cardKeyHash) external;
}

/// @title Tap2ETH wallet v2
/// @notice A wallet controlled by a SET of signers: bank cards (RSA, sign 4 bytes) and phones (passkey, sign the
///         full hash). Normal payments need `threshold` signatures (default 2 of N) and at least one must be a
///         phone, because a card signature alone only binds 4 bytes of the payment. Everything that changes the
///         wallet (limits, signers, threshold) needs the same `threshold` signatures. Optionally, small payments
///         up to `softLimit` need just 1 signature.
contract Tap2EthWalletV2 {
    using SafeERC20 for IERC20;

    enum Kind {
        Card,
        Phone
    }

    /// @dev Card: a = RSA modulus, b = RSA exponent. Phone: a = abi.encode(x), b = abi.encode(y).
    struct Signer {
        Kind kind;
        bool active;
        bytes a;
        bytes b;
    }

    /// @dev One signature in an approval. Card: data = raw RSA signature. Phone: data = abi.encode(PhoneSig).
    struct Sig {
        uint256 id;
        bytes data;
    }

    struct Recovery {
        uint256 oldId;
        bytes modulus;
        bytes exponent;
        uint256 readyAt; // 0 = nothing pending
    }

    uint256 public constant MAX_SIGNERS = 8;

    address public factory;
    bool private initialized;

    mapping(uint256 => Signer) internal _signers;
    mapping(bytes32 => bool) internal _hasKey; // keccak256(abi.encode(a, b)) of every active signer
    uint256 public signerCount; // ids handed out so far (ids are never reused)
    uint256 public activeCount;
    uint256 public phoneCount;

    uint256 public threshold; // signatures needed for normal approvals, 2 <= threshold <= activeCount
    uint256 public softLimit; // payments up to this amount need only 1 signature; 0 = off
    bool public softCardOnly; // if true the single signature may be a card; if false it must be a phone

    uint256 public perTxLimit;
    uint256 public dailyLimit;
    uint256 public spentToday;
    uint256 public spentDay;

    uint256 public nonce;
    bool public frozen;

    uint256 public recoveryDelay;
    Recovery public recovery;

    /// @dev Pending replacement of the phone signer(s), started by two cards without any phone signature.
    struct PhoneRecovery {
        bytes32 x;
        bytes32 y;
        uint256 readyAt; // 0 = nothing pending
    }

    uint256 public constant RECOVERY_CARDS = 2; // different cards needed to start a phone replacement
    PhoneRecovery public phoneRecovery;

    event Paid(address indexed token, address indexed merchant, uint256 amount, uint256 nonce);
    event Frozen(bool frozen, uint256 nonce);
    event LimitsChanged(uint256 perTxLimit, uint256 dailyLimit);
    event SoftLimitChanged(uint256 softLimit, bool cardOnly);
    event ThresholdChanged(uint256 threshold);
    event SignerAdded(uint256 indexed id, Kind kind, bytes32 keyHash);
    event SignerRemoved(uint256 indexed id);
    event RecoveryProposed(uint256 indexed oldId, uint256 readyAt);
    event RecoveryCancelled();
    event RecoveryExecuted(uint256 indexed oldId, uint256 indexed newId);
    event PhoneRecoveryProposed(bytes32 keyHash, uint256 readyAt);
    event PhoneRecoveryCancelled();
    event PhoneRecoveryExecuted(uint256 indexed newId);

    error Expired();
    error IsFrozen();
    error OverLimit();
    error BadSignature();
    error NotEnoughSignatures();
    error SignaturesNotSorted();
    error UnknownSigner();
    error PhoneRequired();
    error BadKey();
    error DuplicateKey();
    error TooManySigners();
    error BelowThreshold();
    error LastPhone();
    error BadThreshold();
    error NoRecovery();
    error RecoveryPending();
    error RecoveryNotReady();
    error AlreadyInitialized();
    error NotCard();
    error NotEnoughCards();

    /// @dev The implementation contract is locked; wallets are clones that get initialized once by the factory.
    constructor() {
        initialized = true;
    }

    function initialize(InitParams calldata p, bytes calldata cardSig, TapSig.PhoneSig calldata phoneSig) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        factory = msg.sender;

        // Proof of possession: the real card and the real phone both sign the creation parameters.
        // This stops anyone from registering a card they don't hold.
        bytes32 h = TapSig.createHash(address(this), p);
        if (!TapSig.verifyRsa(p.cardModulus, p.cardExponent, bytes4(h), cardSig)) revert BadSignature();
        if (!TapSig.verifyWebAuthn(h, phoneSig, p.phoneX, p.phoneY)) revert BadSignature();

        _addSigner(Kind.Card, p.cardModulus, p.cardExponent);
        _addSigner(Kind.Phone, abi.encode(p.phoneX), abi.encode(p.phoneY));
        threshold = 2;
        perTxLimit = p.perTxLimit;
        dailyLimit = p.dailyLimit;
        recoveryDelay = p.recoveryDelay;
    }

    // ------------------------------------------------------------------ views

    function getSigner(uint256 id) external view returns (Kind kind, bool active, bytes memory a, bytes memory b) {
        Signer storage s = _signers[id];
        return (s.kind, s.active, s.a, s.b);
    }

    function paymentHash(address token, address merchant, uint256 amount, uint256 _nonce, uint256 expiry)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode("TAP2ETH_V2_PAY", block.chainid, address(this), token, merchant, amount, _nonce, expiry)
        );
    }

    function actionHash(string memory action, bytes memory params, uint256 expiry) public view returns (bytes32) {
        return keccak256(abi.encode("TAP2ETH_V2_ACTION", action, block.chainid, address(this), params, nonce, expiry));
    }

    // ---------------------------------------------------------------- payments

    /// @notice Pay `amount` of `token` to `merchant`. Needs `threshold` signatures (at least one from a phone), or a
    ///         single signature when `amount <= softLimit`.
    function pay(address token, address merchant, uint256 amount, uint256 expiry, Sig[] calldata sigs) external {
        if (block.timestamp > expiry) revert Expired();
        if (frozen) revert IsFrozen();

        bytes32 h = paymentHash(token, merchant, amount, nonce, expiry);
        bool soft = softLimit > 0 && amount <= softLimit;
        _approve(h, sigs, soft ? 1 : threshold, !(soft && softCardOnly));

        uint256 today = block.timestamp / 1 days;
        if (today != spentDay) {
            spentDay = today;
            spentToday = 0;
        }
        if (amount > perTxLimit || spentToday + amount > dailyLimit) revert OverLimit();

        spentToday += amount;
        uint256 used = nonce++;
        IERC20(token).safeTransfer(merchant, amount);
        emit Paid(token, merchant, amount, used);
    }

    // ------------------------------------------------------------- management

    /// @notice Freeze with a single phone signature: freezing can never move funds.
    function freeze(uint256 expiry, Sig[] calldata sigs) external {
        if (block.timestamp > expiry) revert Expired();
        _approve(actionHash("freeze", "", expiry), sigs, 1, true);
        nonce++;
        frozen = true;
        emit Frozen(true, nonce - 1);
    }

    function unfreeze(uint256 expiry, Sig[] calldata sigs) external {
        if (block.timestamp > expiry) revert Expired();
        _approve(actionHash("unfreeze", "", expiry), sigs, threshold, true);
        nonce++;
        frozen = false;
        emit Frozen(false, nonce - 1);
    }

    function setLimits(uint256 _perTx, uint256 _daily, uint256 expiry, Sig[] calldata sigs) external {
        if (block.timestamp > expiry) revert Expired();
        _approve(actionHash("limits", abi.encode(_perTx, _daily), expiry), sigs, threshold, true);
        nonce++;
        perTxLimit = _perTx;
        dailyLimit = _daily;
        if (softLimit > _perTx) softLimit = _perTx;
        emit LimitsChanged(_perTx, _daily);
    }

    /// @notice Turn the small-payment shortcut on (amount > 0) or off (0). Never above the per-payment limit.
    function setSoftLimit(uint256 _soft, bool cardOnly, uint256 expiry, Sig[] calldata sigs) external {
        if (block.timestamp > expiry) revert Expired();
        if (_soft > perTxLimit) revert OverLimit();
        _approve(actionHash("softLimit", abi.encode(_soft, cardOnly), expiry), sigs, threshold, true);
        nonce++;
        softLimit = _soft;
        softCardOnly = cardOnly;
        emit SoftLimitChanged(_soft, cardOnly);
    }

    function setThreshold(uint256 m, uint256 expiry, Sig[] calldata sigs) external {
        if (block.timestamp > expiry) revert Expired();
        if (m < 2 || m > activeCount) revert BadThreshold();
        _approve(actionHash("threshold", abi.encode(m), expiry), sigs, threshold, true);
        nonce++;
        threshold = m;
        emit ThresholdChanged(m);
    }

    /// @notice Add a card or phone. Needs `threshold` signatures from the existing signers, and the NEW key must sign
    ///         too (`proof`), so nobody can add a key they don't hold.
    function addSigner(
        Kind kind,
        bytes calldata a,
        bytes calldata b,
        uint256 expiry,
        Sig[] calldata sigs,
        bytes calldata proof
    ) external {
        if (block.timestamp > expiry) revert Expired();
        if (activeCount >= MAX_SIGNERS) revert TooManySigners();
        bytes32 h = actionHash("addSigner", abi.encode(kind, keccak256(a), keccak256(b)), expiry);
        _approve(h, sigs, threshold, true);
        _proveKey(kind, a, b, h, proof);
        nonce++;
        uint256 id = _addSigner(kind, a, b);
        if (kind == Kind.Card) ITap2EthFactoryV2(factory).link(keccak256(a));
        emit SignerAdded(id, kind, keccak256(abi.encode(a, b)));
    }

    function removeSigner(uint256 id, uint256 expiry, Sig[] calldata sigs) external {
        if (block.timestamp > expiry) revert Expired();
        Signer storage s = _signers[id];
        if (!s.active) revert UnknownSigner();
        _approve(actionHash("removeSigner", abi.encode(id), expiry), sigs, threshold, true);
        if (activeCount - 1 < threshold) revert BelowThreshold();
        if (s.kind == Kind.Phone && phoneCount == 1) revert LastPhone();
        nonce++;
        _removeSigner(id);
    }

    // --------------------------------------------------------------- recovery

    /// @notice Lost card: one phone signature plus the NEW card's signature start a replacement that only takes
    ///         effect after `recoveryDelay`, and any single signer can cancel it in the meantime.
    function proposeRecovery(
        uint256 oldId,
        bytes calldata newModulus,
        bytes calldata newExponent,
        uint256 expiry,
        Sig[] calldata sigs,
        bytes calldata newCardSig
    ) external {
        if (block.timestamp > expiry) revert Expired();
        if (recovery.readyAt != 0) revert RecoveryPending();
        Signer storage old = _signers[oldId];
        if (!old.active) revert UnknownSigner();
        if (old.kind != Kind.Card) revert NotCard();
        if (_hasKey[keccak256(abi.encode(newModulus, newExponent))]) revert DuplicateKey();

        bytes32 h = actionHash("proposeRecovery", abi.encode(oldId, keccak256(newModulus), keccak256(newExponent)), expiry);
        _approve(h, sigs, 1, true);
        _proveKey(Kind.Card, newModulus, newExponent, h, newCardSig);
        nonce++;
        recovery = Recovery(oldId, newModulus, newExponent, block.timestamp + recoveryDelay);
        emit RecoveryProposed(oldId, block.timestamp + recoveryDelay);
    }

    function executeRecovery() external {
        Recovery memory r = recovery;
        if (r.readyAt == 0) revert NoRecovery();
        if (block.timestamp < r.readyAt) revert RecoveryNotReady();
        delete recovery;
        nonce++;
        _removeSigner(r.oldId);
        uint256 id = _addSigner(Kind.Card, r.modulus, r.exponent);
        ITap2EthFactoryV2(factory).link(keccak256(r.modulus));
        emit RecoveryExecuted(r.oldId, id);
    }

    /// @notice Any single active signer (card or phone) can cancel a pending recovery.
    function cancelRecovery(uint256 expiry, Sig[] calldata sigs) external {
        if (block.timestamp > expiry) revert Expired();
        if (recovery.readyAt == 0) revert NoRecovery();
        _approve(actionHash("cancelRecovery", "", expiry), sigs, 1, false);
        nonce++;
        delete recovery;
        emit RecoveryCancelled();
    }

    // ------------------------------------------------- lost phone: recovery by two cards

    /// @notice The hash the two cards (first 4 bytes) and the new phone (full hash) sign to start a phone replacement.
    function phoneRecoveryHash(bytes32 newX, bytes32 newY, uint256 expiry) public view returns (bytes32) {
        return actionHash("proposePhoneRecovery", abi.encode(newX, newY), expiry);
    }

    /// @notice Lost or wiped phone: at least two DIFFERENT cards plus the new phone start a replacement that only takes
    ///         effect after `recoveryDelay`. Any single active signer can cancel it in the meantime. No phone
    ///         signature is needed to start it. Each card signs only 4 bytes of the request hash.
    function proposePhoneRecovery(
        bytes32 newX,
        bytes32 newY,
        uint256 expiry,
        Sig[] calldata cardSigs,
        bytes calldata newPhoneProof
    ) external virtual {
        _prePhoneRecovery(newX, newY, expiry);
        bytes32 h = phoneRecoveryHash(newX, newY, expiry);
        if (cardSigs.length < RECOVERY_CARDS) revert NotEnoughCards();
        uint256 last;
        for (uint256 i = 0; i < cardSigs.length; i++) {
            Sig calldata sg = cardSigs[i];
            if (i > 0 && sg.id <= last) revert SignaturesNotSorted();
            last = sg.id;
            Signer storage c = _signers[sg.id];
            if (!c.active) revert UnknownSigner();
            if (c.kind != Kind.Card) revert NotCard();
            if (!TapSig.verifyRsa(c.a, c.b, bytes4(h), sg.data)) revert BadSignature();
        }
        _postPhoneRecovery(h, newX, newY, newPhoneProof);
    }

    /// @notice Anyone can finish the replacement once the delay has passed. The new phone is added and every old
    ///         phone is removed.
    function executePhoneRecovery() external {
        PhoneRecovery memory r = phoneRecovery;
        if (r.readyAt == 0) revert NoRecovery();
        if (block.timestamp < r.readyAt) revert RecoveryNotReady();
        delete phoneRecovery;
        nonce++;
        uint256 n = signerCount;
        uint256 newId = _addSigner(Kind.Phone, abi.encode(r.x), abi.encode(r.y));
        for (uint256 i = 0; i < n; i++) {
            if (_signers[i].active && _signers[i].kind == Kind.Phone) _removeSigner(i);
        }
        if (threshold > activeCount) threshold = activeCount;
        emit SignerAdded(newId, Kind.Phone, keccak256(abi.encode(abi.encode(r.x), abi.encode(r.y))));
        emit PhoneRecoveryExecuted(newId);
    }

    /// @notice Any single active signer (card or phone) can cancel a pending phone replacement.
    function cancelPhoneRecovery(uint256 expiry, Sig[] calldata sigs) external {
        if (block.timestamp > expiry) revert Expired();
        if (phoneRecovery.readyAt == 0) revert NoRecovery();
        _approve(actionHash("cancelPhoneRecovery", "", expiry), sigs, 1, false);
        nonce++;
        delete phoneRecovery;
        emit PhoneRecoveryCancelled();
    }

    // ----------------------------------------------------------------- internals

    /// @dev Checks shared by every way of starting a phone replacement.
    function _prePhoneRecovery(bytes32 newX, bytes32 newY, uint256 expiry) internal view {
        if (block.timestamp > expiry) revert Expired();
        if (phoneRecovery.readyAt != 0) revert RecoveryPending();
        if (_hasKey[keccak256(abi.encode(abi.encode(newX), abi.encode(newY)))]) revert DuplicateKey();
    }

    /// @dev The new phone proves it holds its key (it signs the full hash), then the replacement is stored.
    function _postPhoneRecovery(bytes32 h, bytes32 newX, bytes32 newY, bytes calldata newPhoneProof) internal {
        TapSig.PhoneSig memory ps = abi.decode(newPhoneProof, (TapSig.PhoneSig));
        if (!TapSig.verifyWebAuthn(h, ps, newX, newY)) revert BadSignature();
        nonce++;
        phoneRecovery = PhoneRecovery(newX, newY, block.timestamp + recoveryDelay);
        emit PhoneRecoveryProposed(keccak256(abi.encode(newX, newY)), block.timestamp + recoveryDelay);
    }

    function _addSigner(Kind kind, bytes memory a, bytes memory b) internal returns (uint256 id) {
        bytes32 k = keccak256(abi.encode(a, b));
        if (_hasKey[k]) revert DuplicateKey();
        if (kind == Kind.Card) {
            if (a.length < 64 || b.length == 0) revert BadKey();
        } else {
            if (a.length != 32 || b.length != 32) revert BadKey();
            phoneCount++;
        }
        _hasKey[k] = true;
        id = signerCount++;
        _signers[id] = Signer(kind, true, a, b);
        activeCount++;
    }

    function _removeSigner(uint256 id) internal {
        Signer storage s = _signers[id];
        _hasKey[keccak256(abi.encode(s.a, s.b))] = false;
        s.active = false;
        activeCount--;
        if (s.kind == Kind.Phone) phoneCount--;
        else ITap2EthFactoryV2(factory).unlink(keccak256(s.a));
        emit SignerRemoved(id);
    }

    function _proveKey(Kind kind, bytes calldata a, bytes calldata b, bytes32 h, bytes calldata proof) internal view {
        if (kind == Kind.Card) {
            if (!TapSig.verifyRsa(a, b, bytes4(h), proof)) revert BadSignature();
        } else {
            if (a.length != 32 || b.length != 32) revert BadKey();
            TapSig.PhoneSig memory ps = abi.decode(proof, (TapSig.PhoneSig));
            if (!TapSig.verifyWebAuthn(h, ps, abi.decode(a, (bytes32)), abi.decode(b, (bytes32)))) revert BadSignature();
        }
    }

    /// @dev Checks `required` signatures from distinct, active signers (ids strictly increasing). Every signature
    ///      supplied must be valid. If `needPhone`, at least one must come from a phone (full-hash binding).
    function _approve(bytes32 h, Sig[] calldata sigs, uint256 required, bool needPhone) internal view {
        if (sigs.length < required) revert NotEnoughSignatures();
        uint256 last;
        bool phoneSeen;
        for (uint256 i = 0; i < sigs.length; i++) {
            Sig calldata sg = sigs[i];
            if (i > 0 && sg.id <= last) revert SignaturesNotSorted();
            last = sg.id;
            Signer storage s = _signers[sg.id];
            if (!s.active) revert UnknownSigner();
            if (s.kind == Kind.Card) {
                if (!TapSig.verifyRsa(s.a, s.b, bytes4(h), sg.data)) revert BadSignature();
            } else {
                TapSig.PhoneSig memory ps = abi.decode(sg.data, (TapSig.PhoneSig));
                if (!TapSig.verifyWebAuthn(h, ps, abi.decode(s.a, (bytes32)), abi.decode(s.b, (bytes32)))) {
                    revert BadSignature();
                }
                phoneSeen = true;
            }
        }
        if (needPhone && !phoneSeen) revert PhoneRequired();
    }
}

/// @notice Creates one wallet (a cheap clone) per first card. Anyone who reads a card's key can find its wallet,
///         and every card added later is indexed here too.
contract Tap2EthFactoryV2 {
    address public immutable implementation;
    mapping(bytes32 => address) public walletOf; // keccak256(card modulus) => wallet
    mapping(address => bool) public isWallet;

    event WalletCreated(bytes32 indexed cardKeyHash, address wallet);

    constructor() {
        implementation = address(new Tap2EthWalletV2());
    }

    function predict(bytes32 cardKeyHash) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, cardKeyHash, address(this));
    }

    /// @notice The hash the first card (first 4 bytes) and the first phone (full hash) must sign to create a wallet.
    function createHash(InitParams calldata p) external view returns (bytes32) {
        return TapSig.createHash(predict(keccak256(p.cardModulus)), p);
    }

    function createWallet(InitParams calldata p, bytes calldata cardSig, TapSig.PhoneSig calldata phoneSig)
        external
        returns (address wallet)
    {
        bytes32 key = keccak256(p.cardModulus);
        require(walletOf[key] == address(0), "card already registered");
        wallet = Clones.cloneDeterministic(implementation, key);
        isWallet[wallet] = true;
        walletOf[key] = wallet;
        Tap2EthWalletV2(wallet).initialize(p, cardSig, phoneSig);
        emit WalletCreated(key, wallet);
    }

    function link(bytes32 cardKeyHash) external {
        require(isWallet[msg.sender], "not a wallet");
        require(walletOf[cardKeyHash] == address(0), "card already registered");
        walletOf[cardKeyHash] = msg.sender;
    }

    function unlink(bytes32 cardKeyHash) external {
        require(isWallet[msg.sender] && walletOf[cardKeyHash] == msg.sender, "not the wallet");
        delete walletOf[cardKeyHash];
    }
}

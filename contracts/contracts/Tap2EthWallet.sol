// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {SHA1} from "./SHA1.sol";

/// @title Tap2ETH wallet
/// @notice A wallet owned by two keys: an EMV bank card (RSA, signs via INTERNAL AUTHENTICATE)
///         and a phone passkey (P-256 / WebAuthn). Payments need both, plus limits and no freeze.
///         Anyone (the relayer) can submit; the relayer pays gas but cannot forge anything.
contract Tap2EthWallet {
    using SafeERC20 for IERC20;

    /// @dev WebAuthn assertion produced by the phone's passkey.
    struct PhoneSig {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 challengeIndex; // index of `"challenge":"` in clientDataJSON
        uint256 typeIndex; // index of `"type":"webauthn.get"` in clientDataJSON
        bytes32 r;
        bytes32 s;
    }

    address public immutable factory;

    bytes public cardModulus; // card RSA public key modulus (e.g. 128 bytes for 1024-bit)
    bytes public cardExponent; // minimal big-endian exponent (usually 0x03)
    bytes32 public phoneX;
    bytes32 public phoneY;

    uint256 public perTxLimit;
    uint256 public dailyLimit;
    uint256 public spentToday;
    uint256 public spentDay;
    uint256 public nonce;
    bool public frozen;

    event Paid(address indexed token, address indexed merchant, uint256 amount, uint256 nonce);
    event Frozen(bool frozen, uint256 nonce);
    event LimitsChanged(uint256 perTxLimit, uint256 dailyLimit);
    event CardReplaced(bytes32 newCardKeyHash);

    error Expired();
    error IsFrozen();
    error OverLimit();
    error BadCardSignature();
    error BadPhoneSignature();

    constructor(
        bytes memory _cardModulus,
        bytes memory _cardExponent,
        bytes32 _phoneX,
        bytes32 _phoneY,
        uint256 _perTxLimit,
        uint256 _dailyLimit
    ) {
        factory = msg.sender;
        cardModulus = _cardModulus;
        cardExponent = _cardExponent;
        phoneX = _phoneX;
        phoneY = _phoneY;
        perTxLimit = _perTxLimit;
        dailyLimit = _dailyLimit;
    }

    // ------------------------------------------------------------------ hashes

    function paymentHash(address token, address merchant, uint256 amount, uint256 _nonce, uint256 expiry)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode("TAP2ETH_PAY", block.chainid, address(this), token, merchant, amount, _nonce, expiry));
    }

    function actionHash(string memory action, bytes memory params, uint256 _nonce, uint256 expiry)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode("TAP2ETH_ACTION", action, block.chainid, address(this), params, _nonce, expiry));
    }

    // ---------------------------------------------------------------- payments

    /// @notice Pay `amount` of `token` to `merchant`. Needs the card's signature over the first
    ///         4 bytes of the payment hash and the phone's passkey signature over the full hash.
    function pay(
        address token,
        address merchant,
        uint256 amount,
        uint256 expiry,
        bytes calldata cardSig,
        PhoneSig calldata phoneSig
    ) external {
        if (block.timestamp > expiry) revert Expired();
        if (frozen) revert IsFrozen();

        bytes32 h = paymentHash(token, merchant, amount, nonce, expiry);
        if (!verifyCard(bytes4(h), cardSig)) revert BadCardSignature();
        if (!verifyPhone(h, phoneSig)) revert BadPhoneSignature();

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

    /// @notice Freeze with the phone alone: freezing can never move funds.
    function freeze(uint256 expiry, PhoneSig calldata phoneSig) external {
        if (block.timestamp > expiry) revert Expired();
        bytes32 h = actionHash("freeze", "", nonce, expiry);
        if (!verifyPhone(h, phoneSig)) revert BadPhoneSignature();
        nonce++;
        frozen = true;
        emit Frozen(true, nonce - 1);
    }

    /// @notice Unfreeze needs both the card and the phone.
    function unfreeze(uint256 expiry, bytes calldata cardSig, PhoneSig calldata phoneSig) external {
        if (block.timestamp > expiry) revert Expired();
        bytes32 h = actionHash("unfreeze", "", nonce, expiry);
        if (!verifyCard(bytes4(h), cardSig)) revert BadCardSignature();
        if (!verifyPhone(h, phoneSig)) revert BadPhoneSignature();
        nonce++;
        frozen = false;
        emit Frozen(false, nonce - 1);
    }

    /// @notice Change limits; needs card + phone.
    function setLimits(uint256 _perTx, uint256 _daily, uint256 expiry, bytes calldata cardSig, PhoneSig calldata phoneSig)
        external
    {
        if (block.timestamp > expiry) revert Expired();
        bytes32 h = actionHash("limits", abi.encode(_perTx, _daily), nonce, expiry);
        if (!verifyCard(bytes4(h), cardSig)) revert BadCardSignature();
        if (!verifyPhone(h, phoneSig)) revert BadPhoneSignature();
        nonce++;
        perTxLimit = _perTx;
        dailyLimit = _daily;
        emit LimitsChanged(_perTx, _daily);
    }

    /// @notice Replace the card (lost / reissued): the NEW card signs, plus the phone.
    function replaceCard(
        bytes calldata newModulus,
        bytes calldata newExponent,
        uint256 expiry,
        bytes calldata newCardSig,
        PhoneSig calldata phoneSig
    ) external {
        if (block.timestamp > expiry) revert Expired();
        bytes32 h = actionHash("replaceCard", abi.encode(newModulus, newExponent), nonce, expiry);
        if (!verifyPhone(h, phoneSig)) revert BadPhoneSignature();
        if (!_verifyRsa(newModulus, newExponent, bytes4(h), newCardSig)) revert BadCardSignature();
        nonce++;
        Tap2EthFactory(factory).moveCard(keccak256(cardModulus), keccak256(newModulus));
        cardModulus = newModulus;
        cardExponent = newExponent;
        emit CardReplaced(keccak256(newModulus));
    }

    // ----------------------------------------------------------- verification

    /// @notice EMV DDA signature check (ISO/IEC 9796-2 scheme 1, SHA-1) for this wallet's card.
    function verifyCard(bytes4 challenge, bytes calldata sig) public view returns (bool) {
        return _verifyRsa(cardModulus, cardExponent, challenge, sig);
    }

    function _verifyRsa(bytes memory n, bytes memory e, bytes4 challenge, bytes memory sig)
        internal
        view
        returns (bool)
    {
        uint256 len = n.length;
        if (sig.length != len || len < 64) return false;

        (bool ok, bytes memory m) =
            address(0x05).staticcall(abi.encodePacked(len, e.length, len, sig, e, n));
        if (!ok || m.length != len) return false;

        // Recovered block: 6A | 05 | hashAlg | Ldd | dynamic data | BB.. | SHA-1 (20) | BC
        if (m[0] != 0x6A || m[1] != 0x05 || m[len - 1] != 0xBC) return false;

        // hash input = m[1 .. len-22] (everything between header and hash) || terminal DDOL data
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

    /// @notice WebAuthn (passkey) check: clientDataJSON must carry base64url(h) as its challenge,
    ///         be of type webauthn.get, and the authenticator must report user presence + verification.
    function verifyPhone(bytes32 h, PhoneSig calldata ps) public view returns (bool) {
        bytes memory cd = bytes(ps.clientDataJSON);
        bytes memory expectedChallenge = bytes(string.concat('"challenge":"', Base64.encodeURL(abi.encodePacked(h)), '"'));
        if (!_contains(cd, ps.challengeIndex, expectedChallenge)) return false;
        if (!_contains(cd, ps.typeIndex, bytes('"type":"webauthn.get"'))) return false;

        bytes calldata ad = ps.authenticatorData;
        if (ad.length < 37) return false;
        uint8 flags = uint8(ad[32]);
        if (flags & 0x01 == 0 || flags & 0x04 == 0) return false; // UP and UV

        bytes32 digest = sha256(abi.encodePacked(ad, sha256(cd)));
        return P256.verify(digest, ps.r, ps.s, phoneX, phoneY);
    }

    function _contains(bytes memory hay, uint256 at, bytes memory needle) private pure returns (bool) {
        if (at + needle.length > hay.length) return false;
        for (uint256 i = 0; i < needle.length; i++) {
            if (hay[at + i] != needle[i]) return false;
        }
        return true;
    }
}

/// @notice Deploys one wallet per card (CREATE2, salt = hash of the card modulus) so anyone who
///         reads the card's public key can find its wallet.
contract Tap2EthFactory {
    mapping(bytes32 => address) public walletOf; // keccak256(cardModulus) => wallet

    event WalletCreated(bytes32 indexed cardKeyHash, address wallet);

    function createWallet(
        bytes calldata cardModulus,
        bytes calldata cardExponent,
        bytes32 phoneX,
        bytes32 phoneY,
        uint256 perTxLimit,
        uint256 dailyLimit
    ) external returns (address wallet) {
        bytes32 key = keccak256(cardModulus);
        require(walletOf[key] == address(0), "card already registered");
        wallet = address(
            new Tap2EthWallet{salt: key}(cardModulus, cardExponent, phoneX, phoneY, perTxLimit, dailyLimit)
        );
        walletOf[key] = wallet;
        emit WalletCreated(key, wallet);
    }

    /// @notice Called by a wallet when its card is replaced, so the new card finds the same wallet.
    function moveCard(bytes32 oldKey, bytes32 newKey) external {
        require(walletOf[oldKey] == msg.sender, "not the wallet");
        require(walletOf[newKey] == address(0), "card already registered");
        delete walletOf[oldKey];
        walletOf[newKey] = msg.sender;
    }
}

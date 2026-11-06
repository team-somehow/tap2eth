// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {HegotaSupport, Devnet, TxParam, FrameParam, FrameMode, SigParam} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope} from "@forshtat/hegota-support/contracts/Params.sol";
import {Tap2EthVerifier} from "./Tap2EthVerifier.sol";

/// @title Tap2ETH wallet for EIP-8141 frame transactions
/// @notice Same rules as Tap2EthWallet: every payment needs the card and the phone. The alt mempool caps validation at
///         100k gas and refuses precompile calls, so RSA and P-256 cannot run in a VERIFY frame. Validation only does
///         cheap checks and requires the enrolled POS key. The card and phone are verified in pay(), in the SENDER
///         frame. A bad proof therefore moves no funds, but it costs gas from this wallet's paymaster quota.
contract Tap2EthFrameWallet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    using SafeERC20 for IERC20;

    uint256 private constant SIG_SCHEME_SECP256K1 = 1;
    uint256 private constant POS_SIGNATURE = 0;
    uint256 private constant PAY_AMOUNT_OFFSET = 4 + 2 * 32; // selector, token, merchant
    uint256 private constant WINDOW = 1 days;

    Tap2EthVerifier public immutable verifier;
    address public immutable paymaster;
    address public immutable pos;

    bytes public cardModulus;
    bytes public cardExponent;
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
    event QuotaRollFailed();

    error Expired();
    error IsFrozen();
    error OverLimit();
    error BadCardSignature();
    error BadPhoneSignature();
    error BadFrames();
    error UnknownPos();

    constructor(
        bytes memory _cardModulus,
        bytes memory _cardExponent,
        bytes32 _phoneX,
        bytes32 _phoneY,
        uint256 _perTxLimit,
        uint256 _dailyLimit,
        Tap2EthVerifier _verifier,
        address _paymaster,
        address _pos
    ) {
        cardModulus = _cardModulus;
        cardExponent = _cardExponent;
        phoneX = _phoneX;
        phoneY = _phoneY;
        perTxLimit = _perTxLimit;
        dailyLimit = _dailyLimit;
        verifier = _verifier;
        paymaster = _paymaster;
        pos = _pos;
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

    // -------------------------------------------------------------- validation

    /// @notice The VERIFY frame. Frame validation has empty calldata, so it reaches this fallback. It reads no clock
    ///         and calls no precompile, which is what lets it pass the alt mempool's rules.
    fallback() external payable {
        uint256 last = _requirePaymentFrame();
        if (frozen) revert IsFrozen();
        if (uint256(framedataload(PAY_AMOUNT_OFFSET, last)) > perTxLimit) revert OverLimit();
        if (txparam(TxParam.SIGNATURE_COUNT) != 1) revert UnknownPos();
        if (sigparam(POS_SIGNATURE, SigParam.SCHEME) != SIG_SCHEME_SECP256K1) revert UnknownPos();
        if (sigparam(POS_SIGNATURE, SigParam.MSG) != 0) revert UnknownPos();
        if (address(uint160(sigparam(POS_SIGNATURE, SigParam.RESOLVED_SIGNER))) != pos) revert UnknownPos();
        approve(Scope.EXECUTION);
    }

    /// @dev Exactly one SENDER frame, the last, calling pay() here. Without this a POS could append a frame that spends
    ///      from the wallet outside pay(), because execution approval covers every SENDER frame.
    function _requirePaymentFrame() private view returns (uint256 last) {
        last = txparam(TxParam.FRAME_COUNT) - 1;
        for (uint256 i = 0; i < last; i++) {
            if (frameparam(i, FrameParam.MODE) == uint256(FrameMode.SENDER)) revert BadFrames();
        }
        if (frameparam(last, FrameParam.MODE) != uint256(FrameMode.SENDER)) revert BadFrames();
        if (address(uint160(frameparam(last, FrameParam.RESOLVED_TARGET))) != address(this)) revert BadFrames();
        if (frameparam(last, FrameParam.VALUE) != 0) revert BadFrames();
        if (bytes4(framedataload(0, last)) != this.pay.selector) revert BadFrames();
    }

    // ---------------------------------------------------------------- payments

    /// @notice Pay `amount` of `token` to `merchant`. Needs the card's signature over the first 4 bytes of the payment
    ///         hash and the phone's passkey signature over the full hash. Anyone may submit.
    function pay(
        address token,
        address merchant,
        uint256 amount,
        uint256 expiry,
        bytes calldata cardSig,
        Tap2EthVerifier.PhoneSig calldata phoneSig
    ) external {
        if (block.timestamp > expiry) revert Expired();
        if (frozen) revert IsFrozen();

        bytes32 h = paymentHash(token, merchant, amount, nonce, expiry);
        if (!_cardSigned(h, cardSig)) revert BadCardSignature();
        if (!_phoneSigned(h, phoneSig)) revert BadPhoneSignature();

        uint256 today = block.timestamp / WINDOW;
        if (today != spentDay) {
            spentDay = today;
            spentToday = 0;
        }
        if (amount > perTxLimit || spentToday + amount > dailyLimit) revert OverLimit();

        spentToday += amount;
        uint256 used = nonce++;
        IERC20(token).safeTransfer(merchant, amount);
        emit Paid(token, merchant, amount, used);
        _rollQuota();
    }

    /// @dev Validation has no clock, so the quota window restarts here. A failed roll must not undo a valid payment.
    function _rollQuota() private {
        (bool ok,) = paymaster.call(abi.encodeWithSignature("rollQuota()"));
        if (!ok) emit QuotaRollFailed();
    }

    // ------------------------------------------------------------------ freeze

    /// @notice Freeze with the phone alone: freezing can never move funds. Validation checks this flag, so it also
    ///         stops a compromised POS key from spending this wallet's quota.
    function freeze(uint256 expiry, Tap2EthVerifier.PhoneSig calldata phoneSig) external {
        if (block.timestamp > expiry) revert Expired();
        if (!_phoneSigned(actionHash("freeze", "", nonce, expiry), phoneSig)) revert BadPhoneSignature();
        emit Frozen(true, nonce++);
        frozen = true;
    }

    /// @notice Unfreeze needs both the card and the phone.
    function unfreeze(uint256 expiry, bytes calldata cardSig, Tap2EthVerifier.PhoneSig calldata phoneSig) external {
        if (block.timestamp > expiry) revert Expired();
        bytes32 h = actionHash("unfreeze", "", nonce, expiry);
        if (!_cardSigned(h, cardSig)) revert BadCardSignature();
        if (!_phoneSigned(h, phoneSig)) revert BadPhoneSignature();
        emit Frozen(false, nonce++);
        frozen = false;
    }

    function _cardSigned(bytes32 h, bytes calldata sig) private view returns (bool) {
        return verifier.verifyCard(cardModulus, cardExponent, bytes4(h), sig);
    }

    function _phoneSigned(bytes32 h, Tap2EthVerifier.PhoneSig calldata sig) private view returns (bool) {
        return verifier.verifyPhone(h, sig, phoneX, phoneY);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {InitParams, TapSig, Tap2EthWalletV2} from "../v2/Tap2EthV2.sol";

/// @dev The two Uniswap v3 SwapRouter02 functions we use (https://docs.uniswap.org/contracts/v3/reference/periphery/SwapRouter).
interface ISwapRouter02 {
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);

    function refundETH() external payable;
}

/// @title Tap2ETH wallet with Uniswap pay-in-ETH
/// @notice Same wallet as v2 (card + phone signatures, limits, freeze, recovery), plus it can HOLD ETH and pay a
///         merchant an exact amount of a stablecoin by swapping that ETH on Uniswap v3 in the same transaction.
///         The merchant is the swap's recipient, so the stablecoin goes straight to them and nothing is held in between.
contract Tap2EthWalletSwap is Tap2EthWalletV2 {
    ISwapRouter02 public immutable router; // Uniswap v3 SwapRouter02
    address public immutable weth;
    address public immutable stable; // the token merchants are paid in (USDT)

    event PaidWithSwap(address indexed merchant, uint256 stableOut, uint256 ethIn, uint24 fee, uint256 nonce);

    error SwapFailed();

    constructor(address _router, address _weth, address _stable) {
        router = ISwapRouter02(_router);
        weth = _weth;
        stable = _stable;
    }

    /// @notice The wallet can hold ETH. Only `payWithSwap` spends it.
    receive() external payable {}

    /// @notice The hash the signers approve. It binds the merchant, the exact stablecoin amount, the most ETH the
    ///         wallet may spend and the pool fee, so a relayer cannot change any of them.
    function swapPaymentHash(address merchant, uint256 stableOut, uint256 maxEthIn, uint24 fee, uint256 _nonce, uint256 expiry)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode("TAP2ETH_V2_SWAP_PAY", block.chainid, address(this), stable, merchant, stableOut, maxEthIn, fee, _nonce, expiry)
        );
    }

    /// @notice Pay `merchant` exactly `stableOut` of the stablecoin, paid for with at most `maxEthIn` of the wallet's ETH.
    ///         Same approval rules and limits as `pay` (limits count the stablecoin amount). Unused ETH stays in the wallet.
    function payWithSwap(address merchant, uint256 stableOut, uint256 maxEthIn, uint24 fee, uint256 expiry, Sig[] calldata sigs)
        external
    {
        if (block.timestamp > expiry) revert Expired();
        if (frozen) revert IsFrozen();

        bytes32 h = swapPaymentHash(merchant, stableOut, maxEthIn, fee, nonce, expiry);
        bool soft = softLimit > 0 && stableOut <= softLimit;
        _approve(h, sigs, soft ? 1 : threshold, !(soft && softCardOnly));

        uint256 today = block.timestamp / 1 days;
        if (today != spentDay) {
            spentDay = today;
            spentToday = 0;
        }
        if (stableOut > perTxLimit || spentToday + stableOut > dailyLimit) revert OverLimit();
        spentToday += stableOut;
        uint256 used = nonce++;

        uint256 ethIn = _swapToMerchant(merchant, stableOut, maxEthIn, fee);
        emit PaidWithSwap(merchant, stableOut, ethIn, fee, used);
    }

    /// @dev Uniswap: wrap `maxEthIn` ETH, swap WETH -> stablecoin with the merchant as recipient so they get exactly
    ///      `stableOut`, then refund the ETH the swap did not need. Returns the ETH actually spent.
    function _swapToMerchant(address merchant, uint256 stableOut, uint256 maxEthIn, uint24 fee) internal returns (uint256) {
        uint256 balBefore = address(this).balance;
        if (balBefore < maxEthIn) revert SwapFailed();
        router.exactOutputSingle{value: maxEthIn}(
            ISwapRouter02.ExactOutputSingleParams(weth, stable, fee, merchant, stableOut, maxEthIn, 0)
        );
        router.refundETH();
        return balBefore - address(this).balance;
    }
}

/// @notice Same as the v2 factory, but its wallets are `Tap2EthWalletSwap` clones pointed at one Uniswap router,
///         WETH and stablecoin. (The wallet only needs `factory.link/unlink`, so this mirrors Tap2EthFactoryV2.)
contract Tap2EthFactorySwap {
    address public immutable implementation;
    mapping(bytes32 => address) public walletOf; // keccak256(card modulus) => wallet
    mapping(address => bool) public isWallet;

    event WalletCreated(bytes32 indexed cardKeyHash, address wallet);

    constructor(address router, address weth, address stable) {
        implementation = address(new Tap2EthWalletSwap(router, weth, stable));
    }

    function predict(bytes32 cardKeyHash) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, cardKeyHash, address(this));
    }

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

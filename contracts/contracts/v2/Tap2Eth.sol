// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Tap2EthWalletV2, TapSig, InitParams} from "./Tap2EthV2.sol";

/// @title Tap2ETH: one contract that is both the wallet logic and the wallet registry
/// @notice Deploy this once. The deployed copy is the "master": it keeps the card => wallet registry and creates
///         wallets. Each user wallet is a tiny clone of the master's code with its own storage and funds. The
///         master itself is locked and can never act as a wallet, and clones can never act as the registry.
///         Same wallet rules as Tap2EthWalletV2 (card + phone signatures, limits, recovery); this only adds the registry.
contract Tap2Eth is Tap2EthWalletV2 {
    address public immutable master;
    mapping(bytes32 => address) public walletOf; // keccak256(card modulus) => wallet
    mapping(address => bool) public isWallet;

    event WalletCreated(bytes32 indexed cardKeyHash, address wallet);

    modifier onlyMaster() {
        require(address(this) == master, "registry only on the master");
        _;
    }

    /// @dev The base constructor locks this copy as a wallet. Clones copy the code, so `master` is the same in all.
    constructor() {
        master = address(this);
    }

    function predict(bytes32 cardKeyHash) public view onlyMaster returns (address) {
        return Clones.predictDeterministicAddress(master, cardKeyHash, address(this));
    }

    /// @notice The hash the first card (first 4 bytes) and the first phone (full hash) must sign to create a wallet.
    function createHash(InitParams calldata p) external view onlyMaster returns (bytes32) {
        return TapSig.createHash(predict(keccak256(p.cardModulus)), p);
    }

    function createWallet(InitParams calldata p, bytes calldata cardSig, TapSig.PhoneSig calldata phoneSig)
        external
        onlyMaster
        returns (address wallet)
    {
        bytes32 key = keccak256(p.cardModulus);
        require(walletOf[key] == address(0), "card already registered");
        wallet = Clones.cloneDeterministic(master, key);
        isWallet[wallet] = true;
        walletOf[key] = wallet;
        Tap2Eth(wallet).initialize(p, cardSig, phoneSig);
        emit WalletCreated(key, wallet);
    }

    /// @dev Called by a wallet when it adds a card, so that card's wallet can be found too.
    function link(bytes32 cardKeyHash) external onlyMaster {
        require(isWallet[msg.sender], "not a wallet");
        require(walletOf[cardKeyHash] == address(0), "card already registered");
        walletOf[cardKeyHash] = msg.sender;
    }

    function unlink(bytes32 cardKeyHash) external onlyMaster {
        require(isWallet[msg.sender] && walletOf[cardKeyHash] == msg.sender, "not the wallet");
        delete walletOf[cardKeyHash];
    }
}

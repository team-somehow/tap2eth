// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {InitParams, TapSig, Tap2EthWalletV2} from "../v2/Tap2EthV2.sol";

/// @title Tap2ETH wallet v3 (not deployed)
/// @notice Same as v2, except a lost phone can only be replaced with a STRONGER card proof. A card signs just 4
///         bytes, so one card signature can be replayed on a crafted request by someone who holds an old signature
///         of that card (they only need to find a request whose hash starts with the same 4 bytes). Here each card
///         signs THREE 4-byte pieces of the request hash (bytes 0-3, 4-7 and 8-11), so a replay would have to match
///         12 bytes of the hash. The weaker one-piece path of v2 is switched off.
contract Tap2EthWalletV3 is Tap2EthWalletV2 {
    uint256 public constant RECOVERY_PARTS = 3;

    /// @dev One card's proof: its id and one RSA signature per 4-byte piece of the hash.
    struct StrongSig {
        uint256 id;
        bytes[] parts;
    }

    error UseStrongRecovery();
    error WrongPartCount();

    /// @notice The one-piece path from v2 is off in v3.
    function proposePhoneRecovery(bytes32, bytes32, uint256, Sig[] calldata, bytes calldata) external pure override {
        revert UseStrongRecovery();
    }

    /// @notice The hash the cards (three 4-byte pieces each) and the new phone (full hash) sign.
    function strongRecoveryHash(bytes32 newX, bytes32 newY, uint256 expiry) public view returns (bytes32) {
        return actionHash("proposePhoneRecoveryStrong", abi.encode(newX, newY), expiry);
    }

    /// @notice The three 4-byte pieces a card has to sign for hash `h`.
    function recoveryParts(bytes32 h) public pure returns (bytes4[3] memory p) {
        p[0] = bytes4(h);
        p[1] = bytes4(h << 32);
        p[2] = bytes4(h << 64);
    }

    /// @notice Lost or wiped phone: at least two different cards, each signing all three pieces, plus the new phone.
    ///         Takes effect after `recoveryDelay`; any single active signer can cancel it (`cancelPhoneRecovery`).
    function proposePhoneRecoveryStrong(
        bytes32 newX,
        bytes32 newY,
        uint256 expiry,
        StrongSig[] calldata cardSigs,
        bytes calldata newPhoneProof
    ) external {
        _prePhoneRecovery(newX, newY, expiry);
        bytes32 h = strongRecoveryHash(newX, newY, expiry);
        bytes4[3] memory pieces = recoveryParts(h);
        if (cardSigs.length < RECOVERY_CARDS) revert NotEnoughCards();
        uint256 last;
        for (uint256 i = 0; i < cardSigs.length; i++) {
            StrongSig calldata sg = cardSigs[i];
            if (i > 0 && sg.id <= last) revert SignaturesNotSorted();
            last = sg.id;
            if (sg.parts.length != RECOVERY_PARTS) revert WrongPartCount();
            Signer storage c = _signers[sg.id];
            if (!c.active) revert UnknownSigner();
            if (c.kind != Kind.Card) revert NotCard();
            for (uint256 j = 0; j < RECOVERY_PARTS; j++) {
                if (!TapSig.verifyRsa(c.a, c.b, pieces[j], sg.parts[j])) revert BadSignature();
            }
        }
        _postPhoneRecovery(h, newX, newY, newPhoneProof);
    }
}

/// @notice Creates v3 wallets (cheap clones), one per first card. Same as the v2 factory.
contract Tap2EthFactoryV3 {
    address public immutable implementation;
    mapping(bytes32 => address) public walletOf; // keccak256(card modulus) => wallet
    mapping(address => bool) public isWallet;

    event WalletCreated(bytes32 indexed cardKeyHash, address wallet);

    constructor() {
        implementation = address(new Tap2EthWalletV3());
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
        Tap2EthWalletV3(wallet).initialize(p, cardSig, phoneSig);
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

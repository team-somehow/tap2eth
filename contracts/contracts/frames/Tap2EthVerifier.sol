// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {SHA1} from "../SHA1.sol";

/// @notice Stateless card and phone checks, shared by every frame wallet. Frame devnets charge about 1,700 gas per
///         byte of deployed code, so these cannot live in each wallet. Same logic as Tap2EthWallet, except that the
///         phone check uses the P-256 precompile only, without the much larger Solidity fallback.
contract Tap2EthVerifier {
    /// @dev WebAuthn assertion produced by the phone's passkey.
    struct PhoneSig {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 challengeIndex; // index of `"challenge":"` in clientDataJSON
        uint256 typeIndex; // index of `"type":"webauthn.get"` in clientDataJSON
        bytes32 r;
        bytes32 s;
    }

    uint256 private constant MIN_MODULUS_BYTES = 64;
    uint256 private constant SHA1_TRAILER_BYTES = 22; // 20-byte hash, BC trailer, 6A header
    uint256 private constant MIN_AUTH_DATA_BYTES = 37;
    uint8 private constant FLAG_USER_PRESENT = 0x01;
    uint8 private constant FLAG_USER_VERIFIED = 0x04;

    /// @notice EMV DDA signature check (ISO/IEC 9796-2 scheme 1, SHA-1).
    function verifyCard(bytes calldata n, bytes calldata e, bytes4 challenge, bytes calldata sig)
        external
        view
        returns (bool)
    {
        uint256 len = n.length;
        if (sig.length != len || len < MIN_MODULUS_BYTES) return false;

        (bool ok, bytes memory m) = address(0x05).staticcall(abi.encodePacked(len, e.length, len, sig, e, n));
        if (!ok || m.length != len) return false;

        // Recovered block: 6A | 05 | hashAlg | Ldd | dynamic data | BB.. | SHA-1 (20) | BC
        if (m[0] != 0x6A || m[1] != 0x05 || m[len - 1] != 0xBC) return false;

        // Hash input is everything between the header and the hash, followed by the terminal's DDOL data.
        uint256 bodyLen = len - SHA1_TRAILER_BYTES;
        bytes memory input = new bytes(bodyLen + 4);
        for (uint256 i = 0; i < bodyLen; i++) {
            input[i] = m[i + 1];
        }
        for (uint256 i = 0; i < 4; i++) {
            input[bodyLen + i] = challenge[i];
        }

        bytes20 expected;
        assembly {
            expected := mload(add(add(m, 32), sub(len, 21)))
        }
        return SHA1.sha1(input) == expected;
    }

    /// @notice WebAuthn check: clientDataJSON must carry base64url(h) as its challenge, be of type webauthn.get, and
    ///         the authenticator must report user presence and verification.
    function verifyPhone(bytes32 h, PhoneSig calldata ps, bytes32 x, bytes32 y) external view returns (bool) {
        bytes memory cd = bytes(ps.clientDataJSON);
        bytes memory expectedChallenge = bytes(string.concat('"challenge":"', Base64.encodeURL(abi.encodePacked(h)), '"'));
        if (!_contains(cd, ps.challengeIndex, expectedChallenge)) return false;
        if (!_contains(cd, ps.typeIndex, bytes('"type":"webauthn.get"'))) return false;

        bytes calldata ad = ps.authenticatorData;
        if (ad.length < MIN_AUTH_DATA_BYTES) return false;
        uint8 flags = uint8(ad[32]);
        if (flags & FLAG_USER_PRESENT == 0 || flags & FLAG_USER_VERIFIED == 0) return false;

        bytes32 digest = sha256(abi.encodePacked(ad, sha256(cd)));
        return P256.verifyNative(digest, ps.r, ps.s, x, y);
    }

    function _contains(bytes memory hay, uint256 at, bytes memory needle) private pure returns (bool) {
        if (at + needle.length > hay.length) return false;
        for (uint256 i = 0; i < needle.length; i++) {
            if (hay[at + i] != needle[i]) return false;
        }
        return true;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HegotaSupport, Devnet, TxParam, FrameParam, FrameMode} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope} from "@forshtat/hegota-support/contracts/Params.sol";

interface IStakingRegistry {
    function addStake(uint32 unstakeDelaySec) external payable;
}

/// Sponsors gas up to a daily quota per enrolled wallet and a daily budget across all wallets. A quota keyed by the
/// sender counts as the sender's own storage, but the shared budget is a plain slot of this contract, so writing it
/// during validation needs a staked paymaster and the alt mempool.
/// Fund it at creation or with deposit(): a plain transfer would reach fallback() and fail.
contract QuotaPaymaster is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    struct Quota {
        uint128 remaining;
        uint64 windowStart;
    }

    error NotOwner();
    error NotEnrolled();
    error QuotaExceeded();
    error BadPreVerify();

    uint256 private constant WINDOW = 1 days;

    address public immutable owner;
    uint128 public immutable dailyQuota;
    uint128 public immutable dailyBudget;
    uint128 public budgetRemaining;
    uint64 public budgetWindowStart;
    mapping(address => Quota) public quotas;

    constructor(uint128 dailyQuota_, uint128 dailyBudget_) payable {
        owner = msg.sender;
        dailyQuota = dailyQuota_;
        dailyBudget = dailyBudget_;
        budgetRemaining = dailyBudget_;
        budgetWindowStart = uint64(block.timestamp);
    }

    function deposit() external payable {}

    function enrol(address wallet) external {
        if (msg.sender != owner) revert NotOwner();
        quotas[wallet] = Quota({remaining: dailyQuota, windowStart: uint64(block.timestamp)});
    }

    function stake(address registry, uint32 unstakeDelaySec, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        IStakingRegistry(registry).addStake{value: amount}(unstakeDelaySec);
    }

    /// The pre_verify frame. Only the transaction's own sender is charged, so nobody can burn another wallet's quota.
    function consume() external {
        address wallet = address(uint160(txparam(TxParam.SENDER)));
        Quota memory q = quotas[wallet];
        if (q.windowStart == 0) revert NotEnrolled();
        uint256 cost = txparam(TxParam.MAX_COST);
        if (cost > q.remaining || cost > budgetRemaining) revert QuotaExceeded();
        quotas[wallet].remaining = q.remaining - uint128(cost);
        budgetRemaining -= uint128(cost);
    }

    /// Validation has no clock, so the sender's wallet restarts its window from an execution frame.
    function rollQuota() external {
        Quota storage q = quotas[msg.sender];
        if (q.windowStart != 0 && block.timestamp >= q.windowStart + WINDOW) {
            q.remaining = dailyQuota;
            q.windowStart = uint64(block.timestamp);
        }
        if (block.timestamp >= budgetWindowStart + WINDOW) {
            budgetRemaining = dailyBudget;
            budgetWindowStart = uint64(block.timestamp);
        }
    }

    /// The VERIFY(payment) frame: pays only if the previous frame was a successful consume().
    fallback() external payable {
        uint256 previous = txparam(TxParam.CURRENT_FRAME_INDEX) - 1;
        bool targetOk = address(uint160(frameparam(previous, FrameParam.RESOLVED_TARGET))) == address(this);
        bool modeOk = frameparam(previous, FrameParam.MODE) == uint256(FrameMode.DEFAULT);
        bool statusOk = frameparam(previous, FrameParam.STATUS) == 1;
        bool selectorOk = bytes4(framedataload(0, previous)) == this.consume.selector;
        if (!(targetOk && modeOk && statusOk && selectorOk)) revert BadPreVerify();
        approve(Scope.PAYMENT);
    }
}

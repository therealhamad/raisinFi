// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RejectingERC20 is ERC20 {
    error UnauthorizedController();
    error RecipientBlocked();

    address public immutable controller;
    address public blockedRecipient;

    constructor(address initialRecipient, uint256 initialSupply) ERC20("Rejecting Token", "RJT") {
        controller = msg.sender;
        _mint(initialRecipient, initialSupply);
    }

    function setBlockedRecipient(address recipient) external {
        if (msg.sender != controller) revert UnauthorizedController();
        blockedRecipient = recipient;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == blockedRecipient && to != address(0)) revert RecipientBlocked();
        super._update(from, to, value);
    }
}

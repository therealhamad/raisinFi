// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    error InvalidInitialRecipient();

    constructor(
        string memory name_,
        string memory symbol_,
        address initialRecipient,
        uint256 initialSupply
    ) ERC20(name_, symbol_) {
        if (initialRecipient == address(0)) revert InvalidInitialRecipient();
        _mint(initialRecipient, initialSupply);
    }
}

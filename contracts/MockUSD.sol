// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

/// @notice Stablecoin de prueba (6 decimales) para desarrollo y testnets. No usar en producción.
contract MockUSD is IERC20 {
    string public constant name = "Mock USD";
    string public constant symbol = "mUSD";
    uint8 public constant decimals = 6;

    uint256 public override totalSupply;

    mapping(address account => uint256) private _balances;
    mapping(address account => mapping(address spender => uint256)) private _allowances;

    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();

    function balanceOf(address account) public view override returns (uint256) {
        return _balances[account];
    }

    function allowance(address account, address spender) public view override returns (uint256) {
        return _allowances[account][spender];
    }

    function transfer(address to, uint256 value) external override returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external override returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external override returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            unchecked {
                _allowances[from][msg.sender] = allowed - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    function mint(address to, uint256 value) external {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += value;
        _balances[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = _balances[from];
        if (balance < value) revert InsufficientBalance();
        unchecked {
            _balances[from] = balance - value;
        }
        _balances[to] += value;
        emit Transfer(from, to, value);
    }

    function _approve(address account, address spender, uint256 value) private {
        _allowances[account][spender] = value;
        emit Approval(account, spender, value);
    }
}

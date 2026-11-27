// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

/// @title VendingMachine
/// @notice Máquina expendedora multi-producto con pago en ETH nativo o en token ERC20 y custodia
///         (escrow) del importe hasta que el controlador físico confirma la entrega.
///         Si `token` es la dirección cero, la máquina cobra en ETH; si no, en ese ERC20.
contract VendingMachine {
    enum OrderState {
        Pending,
        Dispensed,
        Refunded
    }

    struct Product {
        string name;
        uint96 price;
        uint32 stock;
        bool active;
    }

    struct Order {
        address buyer;
        uint16 productId;
        uint32 quantity;
        OrderState state;
        uint96 amount;
        uint64 deadline;
    }

    uint32 public constant MAX_QUANTITY_LIMIT = 50;
    uint32 public maxQuantity = 10;

    IERC20 public immutable token;

    address public owner;
    address public pendingOwner;
    address public dispenser;
    bool public paused;
    uint64 public dispenseWindow = 5 minutes;

    uint16 public productCount;
    uint256 public orderCount;

    mapping(uint16 productId => Product) public products;
    mapping(uint256 orderId => Order) public orders;
    mapping(address account => uint256) public withdrawable;

    uint256 private _entered;

    error NotOwner();
    error NotPendingOwner();
    error NotDispenser();
    error NotBuyer();
    error ZeroAddress();
    error UnknownProduct();
    error ProductInactive();
    error OutOfStock();
    error InvalidQuantity();
    error ZeroPrice();
    error MachinePaused();
    error OrderNotPending();
    error OrderExpired();
    error OrderNotExpired();
    error NothingToWithdraw();
    error InvalidWindow();
    error InvalidName();
    error WrongPayment();
    error TokenMismatch();
    error TransferFailed();
    error Reentrancy();

    event ProductAdded(uint16 indexed productId, string name, uint96 price, uint32 stock);
    event ProductUpdated(uint16 indexed productId, uint96 price, bool active);
    event ProductRenamed(uint16 indexed productId, string name);
    event StockSet(uint16 indexed productId, uint32 stock);
    event MaxQuantityChanged(uint32 maxQuantity);
    event Restocked(uint16 indexed productId, uint32 units, uint32 stock);
    event OrderCreated(
        uint256 indexed orderId,
        address indexed buyer,
        uint16 indexed productId,
        uint32 quantity,
        uint96 amount,
        uint64 deadline
    );
    event OrderDispensed(uint256 indexed orderId, address indexed dispenser);
    event OrderRefunded(uint256 indexed orderId, address indexed buyer, uint96 amount);
    event DispenserChanged(address indexed dispenser);
    event DispenseWindowChanged(uint64 window);
    event PausedSet(bool paused);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyDispenser() {
        if (msg.sender != dispenser && msg.sender != owner) revert NotDispenser();
        _;
    }

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address token_, address owner_, address dispenser_) {
        if (owner_ == address(0) || dispenser_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        owner = owner_;
        dispenser = dispenser_;
        emit OwnershipTransferred(address(0), owner_);
        emit DispenserChanged(dispenser_);
    }

    receive() external payable {
        revert WrongPayment();
    }

    function addProduct(string calldata name, uint96 price, uint32 stock) external onlyOwner returns (uint16 productId) {
        if (price == 0) revert ZeroPrice();
        productId = ++productCount;
        products[productId] = Product({name: name, price: price, stock: stock, active: true});
        emit ProductAdded(productId, name, price, stock);
    }

    function configureProduct(uint16 productId, uint96 price, bool active) external onlyOwner {
        if (price == 0) revert ZeroPrice();
        Product storage product = _product(productId);
        product.price = price;
        product.active = active;
        emit ProductUpdated(productId, price, active);
    }

    function setProductName(uint16 productId, string calldata name) external onlyOwner {
        if (bytes(name).length == 0 || bytes(name).length > 64) revert InvalidName();
        _product(productId).name = name;
        emit ProductRenamed(productId, name);
    }

    function restock(uint16 productId, uint32 units) external onlyOwner {
        if (units == 0) revert InvalidQuantity();
        Product storage product = _product(productId);
        product.stock += units;
        emit Restocked(productId, units, product.stock);
    }

    function setStock(uint16 productId, uint32 stock) external onlyOwner {
        _product(productId).stock = stock;
        emit StockSet(productId, stock);
    }

    function setMaxQuantity(uint32 value) external onlyOwner {
        if (value == 0 || value > MAX_QUANTITY_LIMIT) revert InvalidQuantity();
        maxQuantity = value;
        emit MaxQuantityChanged(value);
    }

    function buy(uint16 productId, uint32 quantity) external payable nonReentrant returns (uint256 orderId) {
        if (paused) revert MachinePaused();
        if (quantity == 0 || quantity > maxQuantity) revert InvalidQuantity();
        Product storage product = _product(productId);
        if (!product.active) revert ProductInactive();
        if (product.stock < quantity) revert OutOfStock();

        uint96 amount = product.price * quantity;
        bool nativePayment = address(token) == address(0);

        if (nativePayment) {
            if (msg.value != amount) revert WrongPayment();
        } else if (msg.value != 0) {
            revert WrongPayment();
        }

        product.stock -= quantity;

        uint64 deadline = uint64(block.timestamp) + dispenseWindow;
        orderId = ++orderCount;
        orders[orderId] = Order({
            buyer: msg.sender,
            productId: productId,
            quantity: quantity,
            state: OrderState.Pending,
            amount: amount,
            deadline: deadline
        });

        if (!nativePayment) {
            uint256 balanceBefore = token.balanceOf(address(this));
            _safeTransferFrom(msg.sender, address(this), amount);
            if (token.balanceOf(address(this)) - balanceBefore != amount) revert TokenMismatch();
        }

        emit OrderCreated(orderId, msg.sender, productId, quantity, amount, deadline);
    }

    function confirmDispense(uint256 orderId) external onlyDispenser nonReentrant {
        Order storage order = _pendingOrder(orderId);
        if (block.timestamp > order.deadline) revert OrderExpired();
        order.state = OrderState.Dispensed;
        withdrawable[owner] += order.amount;
        emit OrderDispensed(orderId, msg.sender);
    }

    function cancelOrder(uint256 orderId) external onlyDispenser nonReentrant {
        Order storage order = _pendingOrder(orderId);
        _refund(orderId, order);
    }

    function refund(uint256 orderId) external nonReentrant {
        Order storage order = _pendingOrder(orderId);
        if (msg.sender != order.buyer) revert NotBuyer();
        if (block.timestamp <= order.deadline) revert OrderNotExpired();
        _refund(orderId, order);
    }

    function withdraw(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[msg.sender] = 0;
        _safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    function setDispenser(address dispenser_) external onlyOwner {
        if (dispenser_ == address(0)) revert ZeroAddress();
        dispenser = dispenser_;
        emit DispenserChanged(dispenser_);
    }

    function setDispenseWindow(uint64 window) external onlyOwner {
        if (window < 30 || window > 7 days) revert InvalidWindow();
        dispenseWindow = window;
        emit DispenseWindowChanged(window);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function catalog() external view returns (Product[] memory list) {
        list = new Product[](productCount);
        for (uint256 i = 1; i <= productCount; ++i) {
            list[i - 1] = products[uint16(i)];
        }
    }

    function _product(uint16 productId) private view returns (Product storage product) {
        if (productId == 0 || productId > productCount) revert UnknownProduct();
        return products[productId];
    }

    function _pendingOrder(uint256 orderId) private view returns (Order storage order) {
        order = orders[orderId];
        if (order.state != OrderState.Pending) revert OrderNotPending();
    }

    function _refund(uint256 orderId, Order storage order) private {
        order.state = OrderState.Refunded;
        products[order.productId].stock += order.quantity;
        _safeTransfer(order.buyer, order.amount);
        emit OrderRefunded(orderId, order.buyer, order.amount);
    }

    function _safeTransfer(address to, uint256 amount) private {
        if (address(token) == address(0)) {
            (bool sent, ) = payable(to).call{value: amount}("");
            if (!sent) revert TransferFailed();
            return;
        }
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}

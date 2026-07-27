// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./SimpleBet.sol";
import "./BetResolver.sol";

contract BettingFactory is Ownable, Pausable, ReentrancyGuard {
    IERC20 public immutable USDC;
    IBetResolver public immutable resolver;

    address public houseWallet;
    address public defaultBarWallet;

    uint256 public minimumAmountUSD;
    uint256 public feePercent = 5;

    mapping(uint256 => address[]) public betsByMatch;

    // Seguridad: Whitelist, Verificación de apuestas creadas y Cooldown
    mapping(address => bool) public whitelist;
    mapping(address => bool) public isCreatedBet;
    mapping(address => uint256) public lastCreationTime;
    uint256 public cooldownTime = 15; // 15 segundos de cooldown por defecto

    event BetCreated(address indexed betContract, uint256 matchId, address creator, uint256 amountUSDC);
    event BetAccepted(address indexed betContract, address taker, uint256 amountUSDC);
    event FeeDistributed(address house, address bar, uint256 houseAmount, uint256 barAmount);
    event AddedToWhitelist(address indexed venue);
    event RemovedFromWhitelist(address indexed venue);

    constructor(
        address _usdc,
        address _resolver,
        address _houseWallet,
        address _defaultBarWallet,
        uint256 _minimumAmountUSD
    ) Ownable() {
        USDC = IERC20(_usdc);
        resolver = IBetResolver(_resolver);
        houseWallet = _houseWallet;
        defaultBarWallet = _defaultBarWallet;
        minimumAmountUSD = _minimumAmountUSD;
        // Whitelist por defecto para el dueño y billeteras iniciales para facilitar pruebas
        whitelist[msg.sender] = true;
        whitelist[_defaultBarWallet] = true;
    }

    function createBet(uint256 _matchId, uint8 _team, uint256 _amountUSDC) external whenNotPaused nonReentrant returns (address) {
        require(whitelist[msg.sender], "No autorizado");
        require(block.timestamp >= lastCreationTime[msg.sender] + cooldownTime, "Espere para crear otra apuesta");
        require(_amountUSDC >= minimumAmountUSD, "Monto menor al minimo");
        require(_team == 1 || _team == 2, "Equipo invalido");

        lastCreationTime[msg.sender] = block.timestamp;

        uint256 fee = (_amountUSDC * feePercent) / 100;
        uint256 principal = _amountUSDC - fee;

        require(USDC.transferFrom(msg.sender, address(this), _amountUSDC), "Transfer failed");

        SimpleBet newBet = new SimpleBet(
            address(USDC),
            address(resolver),
            houseWallet,
            defaultBarWallet,
            _matchId,
            msg.sender,
            principal,
            _team
        );

        require(USDC.transfer(address(newBet), principal), "Transfer to bet failed");

        uint256 halfFee = fee / 2;
        USDC.transfer(houseWallet, halfFee);
        USDC.transfer(defaultBarWallet, halfFee);

        betsByMatch[_matchId].push(address(newBet));
        isCreatedBet[address(newBet)] = true;

        emit BetCreated(address(newBet), _matchId, msg.sender, _amountUSDC);
        emit FeeDistributed(houseWallet, defaultBarWallet, halfFee, halfFee);

        return address(newBet);
    }

    function addToWhitelist(address _venue) external onlyOwner {
        whitelist[_venue] = true;
        emit AddedToWhitelist(_venue);
    }

    // El frontend puede llamar a esta funcion para saber si un local es seguro
    function removeFromWhitelist(address _venue) external onlyOwner {
        whitelist[_venue] = false;
        emit RemovedFromWhitelist(_venue);
    }

    function setCooldownTime(uint256 _cooldown) external onlyOwner {
        cooldownTime = _cooldown;
    }

    function acceptBet(address _betContract, uint256 _amountUSDC) external whenNotPaused nonReentrant {
        SimpleBet bet = SimpleBet(_betContract);
        require(!bet.isMatched(), "Bet already matched");

        uint256 originalCreatorAmount = bet.amount();
        uint256 requiredUSDC = (originalCreatorAmount * 100) / (100 - feePercent);

        require(_amountUSDC >= requiredUSDC, "Insuficiente USDC para cubrir principal + fee");

        uint256 fee = (_amountUSDC * feePercent) / 100;
        uint256 principal = _amountUSDC - fee;

        require(USDC.transferFrom(msg.sender, address(this), _amountUSDC), "Taker transfer failed");
        require(USDC.transfer(address(bet), principal), "Transfer to bet contract failed");

        uint256 halfFee = fee / 2;
        USDC.transfer(houseWallet, halfFee);
        USDC.transfer(defaultBarWallet, halfFee);

        uint8 takerTeam = bet.creatorTeam() == 1 ? 2 : 1;
        bet.acceptBet(msg.sender, takerTeam);

        emit BetAccepted(_betContract, msg.sender, _amountUSDC);
        emit FeeDistributed(houseWallet, defaultBarWallet, halfFee, halfFee);
    }

    function setWallets(address _house, address _bar) external onlyOwner {
        houseWallet = _house;
        defaultBarWallet = _bar;
    }

    function setMinimumAmount(uint256 _minimum) external onlyOwner {
        minimumAmountUSD = _minimum;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}

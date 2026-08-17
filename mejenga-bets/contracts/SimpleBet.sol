// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

interface IBetResolver {
    function getResult(uint256 _matchId) external view returns (uint8);
    function isCancelled(uint256 _matchId) external view returns (bool);
}

contract SimpleBet is ReentrancyGuard, Pausable {
    IERC20 public immutable USDC;
    IBetResolver public immutable resolver;
    address public immutable houseWallet;
    address public immutable barWallet;
    address public immutable factory;

    uint256 public immutable matchId;
    address public immutable creator;
    address public taker;
    uint256 public immutable amount; // original creator amount minus fee
    uint8 public immutable creatorTeam;
    uint8 public takerTeam;

    bool public isMatched;
    bool public isResolved;

    event BetMatched(address indexed taker);
    event BetResolved(uint8 result, address winner);

    modifier onlyFactory() {
        require(msg.sender == factory, "Only factory");
        _;
    }

    constructor(
        address _usdc,
        address _resolver,
        address _house,
        address _bar,
        uint256 _matchId,
        address _creator,
        uint256 _amount,
        uint8 _team
    ) {
        USDC = IERC20(_usdc);
        resolver = IBetResolver(_resolver);
        houseWallet = _house;
        barWallet = _bar;
        matchId = _matchId;
        creator = _creator;
        amount = _amount;
        creatorTeam = _team;
        factory = msg.sender;
    }

    function acceptBet(address _taker, uint8 _team) external onlyFactory nonReentrant whenNotPaused {
        require(!isMatched, "Ya esta aceptada");
        taker = _taker;
        takerTeam = _team;
        isMatched = true;
        emit BetMatched(_taker);
    }

    function resolve() external nonReentrant whenNotPaused {
        require(isMatched, "No esta matched");
        require(!isResolved, "Ya resuelto");

        uint8 result = resolver.getResult(matchId);
        bool cancelled = resolver.isCancelled(matchId);

        address winner = address(0);

        if (cancelled || result == 3) {
            USDC.transfer(creator, amount);
            USDC.transfer(taker, amount);
        } else if (result == 1) {
            winner = (creatorTeam == 1) ? creator : taker;
            USDC.transfer(winner, amount * 2);
        } else if (result == 2) {
            winner = (creatorTeam == 2) ? creator : taker;
            USDC.transfer(winner, amount * 2);
        } else {
            revert("Match result not determined yet");
        }

        isResolved = true;
        emit BetResolved(result, winner);
    }
}

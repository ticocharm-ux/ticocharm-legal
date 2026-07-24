// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBetResolver {
    function getResult(uint256 _matchId) external view returns (uint8);
    function isCancelled(uint256 _matchId) external view returns (bool);
}

contract MockBetResolver is IBetResolver {
    mapping(uint256 => uint8) public matchResults;
    mapping(uint256 => bool) public cancelledMatches;

    function setResult(uint256 _matchId, uint8 _result) external {
        matchResults[_matchId] = _result;
    }

    function setCancelled(uint256 _matchId, bool _cancelled) external {
        cancelledMatches[_matchId] = _cancelled;
    }

    function getResult(uint256 _matchId) external view override returns (uint8) {
        return matchResults[_matchId];
    }

    function isCancelled(uint256 _matchId) external view override returns (bool) {
        return cancelledMatches[_matchId];
    }
}

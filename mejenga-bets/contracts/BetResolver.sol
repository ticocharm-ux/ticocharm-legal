// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@chainlink/contracts/src/v0.8/functions/dev/v1_0_0/FunctionsClient.sol";
import "@chainlink/contracts/src/v0.8/functions/dev/v1_0_0/libraries/FunctionsRequest.sol";
import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";

contract BetResolver is Ownable, Pausable, ReentrancyGuard, FunctionsClient, AutomationCompatibleInterface {
    using FunctionsRequest for FunctionsRequest.Request;

    bytes32 public donId;
    uint64 public subscriptionId;

    mapping(uint256 => uint8) public matchResults;
    mapping(uint256 => bool) public cancelledMatches;
    mapping(bytes32 => uint256) public requestToMatchId;
    mapping(uint256 => uint256) public matchEndTime;
    mapping(uint256 => bool) public resolutionRequested;

    uint256[] public activeMatchIds;

    event ResultPublished(uint256 indexed matchId, uint8 result);
    event MatchCancelled(uint256 indexed matchId);
    event RequestSent(bytes32 indexed requestId, uint256 matchId);
    event UpkeepPerformed(uint256 indexed matchId);
    event OracleError(bytes32 indexed requestId, string err);

    constructor(
        address _router,
        bytes32 _donId,
        uint64 _subscriptionId
    ) Ownable() FunctionsClient(_router) {
        donId = _donId;
        subscriptionId = _subscriptionId;
    }

    function registerMatch(uint256 _matchId, uint256 _endTime) external onlyOwner {
        require(_endTime > block.timestamp, "End time debe ser futuro");
        matchEndTime[_matchId] = _endTime;
        activeMatchIds.push(_matchId);
    }

    function setCancelled(uint256 _matchId) external onlyOwner {
        cancelledMatches[_matchId] = true;
        emit MatchCancelled(_matchId);
    }

    function getResult(uint256 _matchId) external view returns (uint8) {
        return matchResults[_matchId];
    }

    function isCancelled(uint256 _matchId) external view returns (bool) {
        return cancelledMatches[_matchId];
    }

    function checkUpkeep(bytes calldata /* checkData */) external view override returns (bool upkeepNeeded, bytes memory performData) {
        for (uint256 i = 0; i < activeMatchIds.length; i++) {
            uint256 matchId = activeMatchIds[i];
            if (matchResults[matchId] == 0 && !resolutionRequested[matchId] && !cancelledMatches[matchId] && block.timestamp >= matchEndTime[matchId]) {
                upkeepNeeded = true;
                performData = abi.encode(matchId);
                return (upkeepNeeded, performData);
            }
        }
        return (false, "");
    }

    function performUpkeep(bytes calldata performData) external override {
        uint256 matchId = abi.decode(performData, (uint256));
        if (matchResults[matchId] == 0 && !resolutionRequested[matchId] && !cancelledMatches[matchId]) {
            _requestMatchResult(matchId);
            emit UpkeepPerformed(matchId);
        }
    }

    function _requestMatchResult(uint256 _matchId) internal whenNotPaused {
        string memory source =
            "const matchId = args[0];"
            "const response = await Functions.makeHttpRequest({"
            "  url: `https://api-football-v1.p.rapidapi.com/v3/fixtures?id=${matchId}`,"
            "  headers: { 'x-apisports-key': secrets.API_KEY }"
            "});"
            "if (response.error) throw Error('API Error');"
            "const fixture = response.data.response[0];"
            "if (!fixture || fixture.fixture.status.short !== 'FT') throw Error('No finalizado');"
            "const home = fixture.goals.home || 0;"
            "const away = fixture.goals.away || 0;"
            "let result = 3;"
            "if (home > away) result = 1;"
            "else if (away > home) result = 2;"
            "return Functions.encodeUint256(result);";

        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(source);

        string[] memory args = new string[](1);
        args[0] = uint2str(_matchId);
        req.setArgs(args);

        bytes32 requestId = _sendRequest(req.encodeCBOR(), subscriptionId, 300000, donId);

        requestToMatchId[requestId] = _matchId;
        resolutionRequested[_matchId] = true;

        emit RequestSent(requestId, _matchId);
    }

    function fulfillRequest(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) internal override {
        uint256 matchId = requestToMatchId[requestId];

        if (err.length > 0) {
            emit OracleError(requestId, string(err));
            delete requestToMatchId[requestId];
            return;
        }

        if (matchId == 0) return;

        uint8 result = abi.decode(response, (uint8));
        matchResults[matchId] = result;
        emit ResultPublished(matchId, result);

        delete requestToMatchId[requestId];
    }

    function uint2str(uint256 _i) internal pure returns (string memory) {
        if (_i == 0) return "0";
        uint256 j = _i;
        uint256 len = 0;
        while (j != 0) { len++; j /= 10; }
        bytes memory bstr = new bytes(len);
        while (_i != 0) {
            bstr[--len] = bytes1(uint8(48 + _i % 10));
            _i /= 10;
        }
        return string(bstr);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}

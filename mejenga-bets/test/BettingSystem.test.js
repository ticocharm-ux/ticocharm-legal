const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Mejenga P2P Betting System", function () {
  let mockUSDC;
  let mockResolver;
  let factory;

  let owner;
  let house;
  let bar;
  let creator;
  let taker;
  let other;

  const MINIMUM_AMOUNT = ethers.utils.parseUnits("10", 6); // 10 USDC
  const INITIAL_SUPPLY = ethers.utils.parseUnits("1000000", 6); // 1M USDC

  beforeEach(async function () {
    [owner, house, bar, creator, taker, other] = await ethers.getSigners();

    // Deploy Mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockUSDC = await MockERC20.deploy("USD Coin", "USDC", INITIAL_SUPPLY);
    await mockUSDC.deployed();

    // Deploy Mock BetResolver
    const MockBetResolver = await ethers.getContractFactory("MockBetResolver");
    mockResolver = await MockBetResolver.deploy();
    await mockResolver.deployed();

    // Deploy BettingFactory
    const BettingFactory = await ethers.getContractFactory("BettingFactory");
    factory = await BettingFactory.deploy(
      mockUSDC.address,
      mockResolver.address,
      house.address,
      bar.address,
      MINIMUM_AMOUNT
    );
    await factory.deployed();

    // Distribute USDC to test accounts
    await mockUSDC.transfer(creator.address, ethers.utils.parseUnits("1000", 6));
    await mockUSDC.transfer(taker.address, ethers.utils.parseUnits("1000", 6));
  });

  describe("Deployment & Configuration", function () {
    it("Should set the correct USDC, resolver, wallets and min amount", async function () {
      expect(await factory.USDC()).to.equal(mockUSDC.address);
      expect(await factory.resolver()).to.equal(mockResolver.address);
      expect(await factory.houseWallet()).to.equal(house.address);
      expect(await factory.defaultBarWallet()).to.equal(bar.address);
      expect(await factory.minimumAmountUSD()).to.equal(MINIMUM_AMOUNT);
    });

    it("Should allow owner to update wallets and minimum amount", async function () {
      await factory.setWallets(other.address, other.address);
      expect(await factory.houseWallet()).to.equal(other.address);
      expect(await factory.defaultBarWallet()).to.equal(other.address);

      const newMin = ethers.utils.parseUnits("20", 6);
      await factory.setMinimumAmount(newMin);
      expect(await factory.minimumAmountUSD()).to.equal(newMin);
    });

    it("Should prevent non-owners from updating wallets or minimum amount", async function () {
      await expect(
        factory.connect(creator).setWallets(other.address, other.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(
        factory.connect(creator).setMinimumAmount(1)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  describe("Security: Whitelist, Cooldown & Factory Verification", function () {
    const betAmount = ethers.utils.parseUnits("100", 6);

    beforeEach(async function () {
      await mockUSDC.connect(creator).approve(factory.address, betAmount);
      await mockUSDC.connect(other).approve(factory.address, betAmount);
    });

    it("Should reject bet creation from non-whitelisted address", async function () {
      // creator is not on the whitelist yet
      await expect(
        factory.connect(creator).createBet(42, 1, betAmount)
      ).to.be.revertedWith("No autorizado");
    });

    it("Should allow bet creation after adding to whitelist", async function () {
      await factory.addToWhitelist(creator.address);
      expect(await factory.whitelist(creator.address)).to.be.true;

      const tx = await factory.connect(creator).createBet(42, 1, betAmount);
      const receipt = await tx.wait();
      const betAddress = receipt.events.find(e => e.event === "BetCreated").args.betContract;

      expect(await factory.isCreatedBet(betAddress)).to.be.true;
    });

    it("Should reject creation if called within the cooldown period", async function () {
      await factory.addToWhitelist(creator.address);

      // First bet creation
      await factory.connect(creator).createBet(42, 1, betAmount);

      // Second bet creation immediately should fail due to cooldown
      await mockUSDC.connect(creator).approve(factory.address, betAmount);
      await expect(
        factory.connect(creator).createBet(42, 1, betAmount)
      ).to.be.revertedWith("Espere para crear otra apuesta");
    });

    it("Should allow creation after cooldown time passes or if cooldown is set to 0", async function () {
      await factory.addToWhitelist(creator.address);
      await factory.connect(creator).createBet(42, 1, betAmount);

      // Reduce cooldown to 0 to test bypass
      await factory.setCooldownTime(0);
      await mockUSDC.connect(creator).approve(factory.address, betAmount);

      const tx = await factory.connect(creator).createBet(42, 1, betAmount);
      const receipt = await tx.wait();
      const betAddress = receipt.events.find(e => e.event === "BetCreated").args.betContract;
      expect(await factory.isCreatedBet(betAddress)).to.be.true;
    });

    it("Should correctly track isCreatedBet for factory-created contracts only", async function () {
      expect(await factory.isCreatedBet(other.address)).to.be.false;
    });
  });

  describe("Bet Creation", function () {
    const betAmount = ethers.utils.parseUnits("100", 6); // 100 USDC

    beforeEach(async function () {
      await mockUSDC.connect(creator).approve(factory.address, betAmount);
      // Whitelist creator for standard bet tests
      await factory.addToWhitelist(creator.address);
    });

    it("Should create a bet successfully with correct fee distribution", async function () {
      const houseBalanceBefore = await mockUSDC.balanceOf(house.address);
      const barBalanceBefore = await mockUSDC.balanceOf(bar.address);

      // Create bet for match 42, team 1
      const tx = await factory.connect(creator).createBet(42, 1, betAmount);
      const receipt = await tx.wait();

      const event = receipt.events.find(e => e.event === "BetCreated");
      expect(event).to.not.be.undefined;

      const betAddress = event.args.betContract;
      const SimpleBet = await ethers.getContractFactory("SimpleBet");
      const bet = SimpleBet.attach(betAddress);

      // Verify SimpleBet variables
      expect(await bet.matchId()).to.equal(42);
      expect(await bet.creator()).to.equal(creator.address);
      expect(await bet.creatorTeam()).to.equal(1);
      expect(await bet.isMatched()).to.be.false;

      // Fee calculations (5% of 100 is 5 USDC, divided to 2.5 each)
      const expectedFee = ethers.utils.parseUnits("5", 6);
      const expectedHalfFee = ethers.utils.parseUnits("2.5", 6);
      const expectedPrincipal = ethers.utils.parseUnits("95", 6);

      expect(await bet.amount()).to.equal(expectedPrincipal);
      expect(await mockUSDC.balanceOf(betAddress)).to.equal(expectedPrincipal);

      const houseBalanceAfter = await mockUSDC.balanceOf(house.address);
      const barBalanceAfter = await mockUSDC.balanceOf(bar.address);

      expect(houseBalanceAfter.sub(houseBalanceBefore)).to.equal(expectedHalfFee);
      expect(barBalanceAfter.sub(barBalanceBefore)).to.equal(expectedHalfFee);
    });

    it("Should revert if amount is less than minimum", async function () {
      const smallAmount = ethers.utils.parseUnits("5", 6);
      await mockUSDC.connect(creator).approve(factory.address, smallAmount);

      await expect(
        factory.connect(creator).createBet(42, 1, smallAmount)
      ).to.be.revertedWith("Monto menor al minimo");
    });

    it("Should revert if team is invalid", async function () {
      await expect(
        factory.connect(creator).createBet(42, 3, betAmount)
      ).to.be.revertedWith("Equipo invalido");
    });
  });

  describe("Bet Acceptance", function () {
    const creatorAmount = ethers.utils.parseUnits("100", 6); // 100 USDC (95 principal + 5 fee)
    let betAddress;
    let bet;

    beforeEach(async function () {
      await factory.addToWhitelist(creator.address);
      await mockUSDC.connect(creator).approve(factory.address, creatorAmount);
      const tx = await factory.connect(creator).createBet(101, 1, creatorAmount);
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "BetCreated");
      betAddress = event.args.betContract;

      const SimpleBet = await ethers.getContractFactory("SimpleBet");
      bet = SimpleBet.attach(betAddress);
    });

    it("Should allow a taker to accept the bet with matching principal + fee", async function () {
      const takerAmount = ethers.utils.parseUnits("100", 6); // Taker must also provide 100 USDC to cover 95 principal + 5 fee
      await mockUSDC.connect(taker).approve(factory.address, takerAmount);

      const houseBalanceBefore = await mockUSDC.balanceOf(house.address);
      const barBalanceBefore = await mockUSDC.balanceOf(bar.address);

      await expect(factory.connect(taker).acceptBet(betAddress, takerAmount))
        .to.emit(factory, "BetAccepted")
        .withArgs(betAddress, taker.address, takerAmount)
        .to.emit(bet, "BetMatched")
        .withArgs(taker.address);

      expect(await bet.isMatched()).to.be.true;
      expect(await bet.taker()).to.equal(taker.address);
      expect(await bet.takerTeam()).to.equal(2); // Since creator was team 1, taker is team 2

      // SimpleBet contract should now hold 95 + 95 = 190 USDC
      expect(await mockUSDC.balanceOf(betAddress)).to.equal(ethers.utils.parseUnits("190", 6));

      // Fees from taker acceptance: 5 USDC divided to 2.5 each
      const houseBalanceAfter = await mockUSDC.balanceOf(house.address);
      const barBalanceAfter = await mockUSDC.balanceOf(bar.address);

      expect(houseBalanceAfter.sub(houseBalanceBefore)).to.equal(ethers.utils.parseUnits("2.5", 6));
      expect(barBalanceAfter.sub(barBalanceBefore)).to.equal(ethers.utils.parseUnits("2.5", 6));
    });

    it("Should revert if taker provides insufficient amount", async function () {
      const lowTakerAmount = ethers.utils.parseUnits("80", 6);
      await mockUSDC.connect(taker).approve(factory.address, lowTakerAmount);

      await expect(
        factory.connect(taker).acceptBet(betAddress, lowTakerAmount)
      ).to.be.revertedWith("Insuficiente USDC para cubrir principal + fee");
    });

    it("Should prevent double acceptance", async function () {
      const takerAmount = ethers.utils.parseUnits("100", 6);
      await mockUSDC.connect(taker).approve(factory.address, takerAmount);
      await factory.connect(taker).acceptBet(betAddress, takerAmount);

      await mockUSDC.connect(other).approve(factory.address, takerAmount);
      await expect(
        factory.connect(other).acceptBet(betAddress, takerAmount)
      ).to.be.revertedWith("Bet already matched");
    });
  });

  describe("Bet Resolution", function () {
    const betAmount = ethers.utils.parseUnits("100", 6);
    let betAddress;
    let bet;

    beforeEach(async function () {
      // Create and accept a bet
      await factory.addToWhitelist(creator.address);
      await mockUSDC.connect(creator).approve(factory.address, betAmount);
      let tx = await factory.connect(creator).createBet(202, 1, betAmount);
      let receipt = await tx.wait();
      betAddress = receipt.events.find(e => e.event === "BetCreated").args.betContract;

      const SimpleBet = await ethers.getContractFactory("SimpleBet");
      bet = SimpleBet.attach(betAddress);

      await mockUSDC.connect(taker).approve(factory.address, betAmount);
      await factory.connect(taker).acceptBet(betAddress, betAmount);
    });

    it("Should pay out the full pool to creator if creator's team wins", async function () {
      // Mock result: 1 (Home/Creator wins)
      await mockResolver.setResult(202, 1);

      const creatorBalanceBefore = await mockUSDC.balanceOf(creator.address);

      await expect(bet.resolve())
        .to.emit(bet, "BetResolved")
        .withArgs(1, creator.address);

      expect(await bet.isResolved()).to.be.true;

      // Creator gets 190 USDC (amount * 2)
      const creatorBalanceAfter = await mockUSDC.balanceOf(creator.address);
      expect(creatorBalanceAfter.sub(creatorBalanceBefore)).to.equal(ethers.utils.parseUnits("190", 6));
      expect(await mockUSDC.balanceOf(betAddress)).to.equal(0);
    });

    it("Should pay out the full pool to taker if taker's team wins", async function () {
      // Mock result: 2 (Away/Taker wins)
      await mockResolver.setResult(202, 2);

      const takerBalanceBefore = await mockUSDC.balanceOf(taker.address);

      await expect(bet.resolve())
        .to.emit(bet, "BetResolved")
        .withArgs(2, taker.address);

      expect(await bet.isResolved()).to.be.true;

      // Taker gets 190 USDC (amount * 2)
      const takerBalanceAfter = await mockUSDC.balanceOf(taker.address);
      expect(takerBalanceAfter.sub(takerBalanceBefore)).to.equal(ethers.utils.parseUnits("190", 6));
      expect(await mockUSDC.balanceOf(betAddress)).to.equal(0);
    });

    it("Should refund both players equally if the match is a draw (result = 3)", async function () {
      // Mock result: 3 (Draw)
      await mockResolver.setResult(202, 3);

      const creatorBalanceBefore = await mockUSDC.balanceOf(creator.address);
      const takerBalanceBefore = await mockUSDC.balanceOf(taker.address);

      await expect(bet.resolve())
        .to.emit(bet, "BetResolved")
        .withArgs(3, ethers.constants.AddressZero);

      expect(await bet.isResolved()).to.be.true;

      // Both players get their principal (95 USDC) back
      const creatorBalanceAfter = await mockUSDC.balanceOf(creator.address);
      const takerBalanceAfter = await mockUSDC.balanceOf(taker.address);

      expect(creatorBalanceAfter.sub(creatorBalanceBefore)).to.equal(ethers.utils.parseUnits("95", 6));
      expect(takerBalanceAfter.sub(takerBalanceBefore)).to.equal(ethers.utils.parseUnits("95", 6));
      expect(await mockUSDC.balanceOf(betAddress)).to.equal(0);
    });

    it("Should refund both players equally if the match is cancelled", async function () {
      // Mock result as cancelled in the resolver
      await mockResolver.setCancelled(202, true);

      const creatorBalanceBefore = await mockUSDC.balanceOf(creator.address);
      const takerBalanceBefore = await mockUSDC.balanceOf(taker.address);

      await expect(bet.resolve())
        .to.emit(bet, "BetResolved")
        .withArgs(0, ethers.constants.AddressZero);

      expect(await bet.isResolved()).to.be.true;

      // Both players get their principal (95 USDC) back
      const creatorBalanceAfter = await mockUSDC.balanceOf(creator.address);
      const takerBalanceAfter = await mockUSDC.balanceOf(taker.address);

      expect(creatorBalanceAfter.sub(creatorBalanceBefore)).to.equal(ethers.utils.parseUnits("95", 6));
      expect(takerBalanceAfter.sub(takerBalanceBefore)).to.equal(ethers.utils.parseUnits("95", 6));
    });

    it("Should revert if trying to resolve before oracle result is available", async function () {
      // Result is 0 (unresolved)
      await mockResolver.setResult(202, 0);

      await expect(bet.resolve()).to.be.revertedWith("Match result not determined yet");
    });
  });
});

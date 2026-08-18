// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.30;

/// @notice SPCX/USDG 전용 UP Slipstream adaptive 5-tick 자동 재배치 금고.
/// @dev keeper는 고정 경로의 중앙·방어 재배치, Vault 내부 USDG 대기, 회복 재진입, UP 수확만 할 수 있다.
///      모든 외부 출금은 immutable recipient로만 간다.
///      배포 전 독립적인 보안 감사를 권장한다.
contract BStockerThreeTickVault {
    address public constant POOL = 0x9d590437ABaAe12cf9fE0627cAF4CFd633152599;
    address public constant GAUGE = 0x01a47258375735D36D15dE8A2bb8e0cE876d31f6;
    address public constant POSITION_MANAGER = 0x07F44c47743A2f36414A82b9F558ECFCf0EEdCEf;
    address public constant SWAP_ROUTER = 0xC062b870E813fcA720f1e002c234369Ab3aB9415;
    address public constant SPCX = 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa;
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address public constant UP = 0x57C0E45cB534413D1C20A4240955d6bB250BB4F1;
    int24 public constant TICK_SPACING = 10;
    int24 public constant RANGE_INTERVALS = 5;
    int24 public constant RANGE_WIDTH = 50;
    int24 public constant EXPECTED_TICK_TOLERANCE = 10;
    int24 public constant SWAP_PRICE_LIMIT_TICKS = 100;
    int24 public constant SPOT_TWAP_30_MAX_TICKS = 50;
    int24 public constant TWAP_30_300_MAX_TICKS = 75;
    int24 public constant FIVE_MINUTE_CRASH_TICKS = 305; // 약 -3%, Keeper 자동 Vault 내부 USDG 대기 기준
    int24 public constant SLOW_DROP_15_TWAP_TICKS = 25; // 선형 하락 기준 약 15분 -0.5%
    int24 public constant SLOW_DROP_30_TWAP_TICKS = 38; // 선형 하락 기준 약 30분 -0.75%
    int24 public constant DEFENSE_EXIT_TICKS = 20; // 방어 진입 기준에서 약 -0.20%
    int24 public constant RECOVERY_15_TWAP_TICKS = 25; // 최근 15분 평균이 이전 15분보다 약 +0.25%
    uint16 public constant REQUIRED_ORACLE_CARDINALITY = 256;
    // v3 keeps the uncapped capital model. ERC20 balances and uint256
    // arithmetic remain the practical upper bound; callers approve only the
    // exact amount supplied when a position starts.
    uint256 public constant MAX_PILOT_USDG = type(uint256).max;
    uint256 public constant MAX_DEADLINE_DELAY = 30 seconds;
    uint256 public constant MAX_START_DEADLINE_DELAY = 5 minutes;
    uint256 public constant MIN_REBALANCE_INTERVAL = 30 seconds;
    uint256 public constant MAX_REBALANCES_10_MIN = 3;
    uint256 public constant MAX_REBALANCES_1_HOUR = 10;
    uint256 public constant NORMAL_SLIPPAGE_BPS = 100; // 1.00%, 현재 0.05% pool fee 포함
    uint256 public constant EMERGENCY_SLIPPAGE_BPS = 100; // 1.00%
    uint256 public constant MAX_UNUSED_BPS = 1_000; // 미사용 자산은 Vault에 안전하게 남기되 10%를 넘으면 전체 tx revert
    uint256 public constant MAX_BALANCE_PASSES = 10;
    uint256 public constant BALANCE_STOP_BPS = 1; // 다음 보정액이 총 가치의 0.01% 이하면 추가 스왑을 멈춘다.
    uint24 public constant MAX_POOL_FEE_PIPS = 10_000; // 1.00%
    uint256 public constant MIN_DEFENSIVE_DURATION = 30 minutes;
    uint256 public constant MIN_USDG_WAIT_DURATION = 60 minutes;

    uint256 private constant BPS = 10_000;
    uint256 private constant FEE_PIPS = 1_000_000;
    uint256 private constant Q96 = 0x1000000000000000000000000;

    enum Mode {
        PAUSED,
        LIVE,
        SOFT_PAUSE,
        WITHDRAW_ONLY,
        DEFENSIVE,
        USDG_WAIT
    }

    address public immutable owner;
    address public keeper;
    address public guardian;
    address public immutable recipient;
    Mode public mode;
    uint256 public activeTokenId;
    uint256 public principalUsdg;
    uint256 public totalRebalances;
    uint256 public totalHarvestedUp;
    uint64 public lastRebalanceAt;
    uint8 private rebalanceCursor;
    uint64[10] private rebalanceHistory;
    uint256 private entered = 1;
    uint64 public modeChangedAt;
    int24 public defensiveAnchor;

    event KeeperUpdated(address indexed keeper);
    event GuardianUpdated(address indexed guardian);
    event ModeChanged(Mode indexed previousMode, Mode indexed nextMode, address indexed caller);
    event PositionStarted(uint256 indexed tokenId, int24 tickLower, int24 tickUpper, uint256 principalUsdg);
    event PositionRebalanced(
        uint256 indexed previousTokenId,
        uint256 indexed nextTokenId,
        int24 tickLower,
        int24 tickUpper
    );
    event PositionIdled(uint256 indexed tokenId, uint256 spcxBalance, uint256 usdgBalance);
    event PositionExited(uint256 indexed tokenId, bool swappedToUsdg, uint256 spcxReturned, uint256 usdgReturned);
    event DefensivePositionEntered(uint256 indexed previousTokenId, uint256 indexed nextTokenId, int24 anchor, int24 tickLower, int24 tickUpper);
    event UsdgParked(uint256 indexed previousTokenId, uint256 usdgBalance, int24 triggerTick);
    event NormalPositionResumed(uint256 indexed previousTokenId, uint256 indexed nextTokenId, int24 tickLower, int24 tickUpper);
    event RewardHarvested(uint256 amountUp);

    error Unauthorized();
    error ReentrantCall();
    error InvalidAddress();
    error InvalidMode();
    error InvalidDeadline();
    error InvalidTick();
    error InvalidRange();
    error InvalidRoute();
    error InvalidSlippage();
    error EmergencySwapIncomplete(uint256 remainingSpcx);
    error IdleBalanceTooHigh(uint256 idleValueUsdg, uint256 totalValueUsdg);
    error InvalidPosition();
    error RateLimited();
    error OracleNotReady();
    error PriceGuardFailed();
    error TrendNotConfirmed();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != owner && msg.sender != keeper) revert Unauthorized();
        _;
    }

    modifier onlySafetyOperator() {
        if (msg.sender != owner && msg.sender != keeper && msg.sender != guardian) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (entered != 1) revert ReentrantCall();
        entered = 2;
        _;
        entered = 1;
    }

    constructor(address initialOwner, address fixedRecipient, address initialKeeper, address initialGuardian) {
        if (initialOwner == address(0) || fixedRecipient == address(0) || initialKeeper == address(0) || initialGuardian == address(0)) {
            revert InvalidAddress();
        }
        owner = initialOwner;
        recipient = fixedRecipient;
        keeper = initialKeeper;
        guardian = initialGuardian;
        mode = Mode.PAUSED;
        modeChangedAt = uint64(block.timestamp);
        _assertDeployment();
    }

    function version() external pure returns (string memory) {
        return "3.0.0";
    }

    function setKeeper(address nextKeeper) external onlyOwner {
        if (nextKeeper == address(0)) revert InvalidAddress();
        keeper = nextKeeper;
        emit KeeperUpdated(nextKeeper);
    }

    function setGuardian(address nextGuardian) external onlyOwner {
        if (nextGuardian == address(0)) revert InvalidAddress();
        guardian = nextGuardian;
        emit GuardianUpdated(nextGuardian);
    }

    function pause() external onlySafetyOperator {
        if (mode == Mode.WITHDRAW_ONLY) revert InvalidMode();
        _setMode(Mode.SOFT_PAUSE);
    }

    function resume() external onlyOwner {
        if (activeTokenId == 0) revert InvalidPosition();
        _validatedMarketTick(_currentTick());
        _setMode(Mode.LIVE);
    }

    /// @notice 보유한 SPCX/USDG 중 하나 또는 둘을 받아 현재 5틱 비율로 자동 스왑·민트·Gauge 예치한다.
    /// @dev 입력액은 0보다 커야 하며 온체인 상한은 두지 않는다. 연결 지갑은 정확한 승인 수량을 직접 확인해야 한다.
    function start(uint256 amountSpcx, uint256 amountUsdg, int24 expectedTick, uint256 deadline)
        external
        onlyOwner
        nonReentrant
        returns (uint256 tokenId)
    {
        if ((mode != Mode.PAUSED && mode != Mode.WITHDRAW_ONLY) || activeTokenId != 0) revert InvalidMode();
        if (amountSpcx == 0 && amountUsdg == 0) revert InvalidPosition();
        if (IERC20(SPCX).balanceOf(address(this)) != 0 || IERC20(USDG).balanceOf(address(this)) != 0) revert InvalidPosition();
        _validateStartDeadline(deadline);
        (uint160 sqrtPriceX96, int24 tick) = _validatedMarketTick(expectedTick);
        uint256 principal = _quoteToken0To1(amountSpcx, sqrtPriceX96) + amountUsdg;
        if (principal == 0) revert InvalidPosition();

        if (amountSpcx != 0) _safeTransferFrom(SPCX, msg.sender, address(this), amountSpcx);
        if (amountUsdg != 0) _safeTransferFrom(USDG, msg.sender, address(this), amountUsdg);

        int24 tickLower;
        int24 tickUpper;
        (tokenId, tickLower, tickUpper) = _balanceMintAndStake(sqrtPriceX96, tick, deadline, false);
        activeTokenId = tokenId;
        principalUsdg = principal;
        _setMode(Mode.LIVE);
        emit PositionStarted(tokenId, tickLower, tickUpper, principal);
    }

    /// @notice keeper가 호출하는 완전 자동 재배치. 회수 잔액을 현재 5틱 비율로 맞춘 뒤 새 NFT를 Gauge에 예치한다.
    /// @dev 시세 변화·비율 오차·최소수령·오라클 가드 중 하나라도 실패하면 철회부터 민트까지 전부 원자적으로 revert된다.
    function rebalanceAuto(int24 expectedTick, uint256 deadline)
        external
        onlyOperator
        nonReentrant
        returns (uint256 nextTokenId)
    {
        if (mode != Mode.LIVE || activeTokenId == 0) revert InvalidMode();
        _validateDeadline(deadline);
        (uint160 beforeSqrtPriceX96, int24 beforeTick) = _validatedMarketTick(expectedTick);
        _consumeRebalanceSlot();
        (, nextTokenId,,) = _replacePosition(beforeSqrtPriceX96, beforeTick, deadline, false);
    }

    /// @notice 15·30분 하락 추세가 온체인 TWAP으로 확인되면 동일 폭의 USDG 편향 5틱으로 원자적 재배치한다.
    function enterDefensiveAuto(int24 expectedTick, uint256 deadline)
        external
        onlyOperator
        nonReentrant
        returns (uint256 nextTokenId)
    {
        if (mode != Mode.LIVE || activeTokenId == 0) revert InvalidMode();
        _validateDeadline(deadline);
        (uint160 beforeSqrtPriceX96, int24 beforeTick) = _validatedMarketTick(expectedTick);
        if (!_slowDowntrendConfirmed(beforeTick)) revert TrendNotConfirmed();
        _consumeRebalanceSlot();

        uint256 previousTokenId;
        int24 tickLower;
        int24 tickUpper;
        (previousTokenId, nextTokenId, tickLower, tickUpper) = _replacePosition(beforeSqrtPriceX96, beforeTick, deadline, true);
        defensiveAnchor = tickLower + (TICK_SPACING * 4);
        _setMode(Mode.DEFENSIVE);
        emit DefensivePositionEntered(previousTokenId, nextTokenId, defensiveAnchor, tickLower, tickUpper);
    }

    /// @notice 방어 기준 추가 하락 또는 5분 급락 때 SPCX를 USDG로 바꾸되 자산을 Vault 내부에 보관한다.
    function parkInUsdgAuto(uint256 deadline) external onlySafetyOperator nonReentrant returns (uint256 amountOut) {
        if (mode != Mode.LIVE && mode != Mode.DEFENSIVE) revert InvalidMode();
        _validateDeadline(deadline);
        (, int24 tick,,,,) = ICLPool(POOL).slot0();
        bool defenseDrop = mode == Mode.DEFENSIVE && tick <= defensiveAnchor - DEFENSE_EXIT_TICKS;
        if (!defenseDrop && !_fiveMinuteCrashConfirmed()) revert TrendNotConfirmed();
        uint256 previousTokenId = activeTokenId;
        if (previousTokenId != 0) {
            _withdrawPosition(previousTokenId, deadline);
            activeTokenId = 0;
        }
        amountOut = _swapVaultSpcxToUsdg(tick, deadline);
        _setMode(Mode.USDG_WAIT);
        _sendAll(UP, recipient);
        emit UsdgParked(previousTokenId, IERC20(USDG).balanceOf(address(this)), tick);
    }

    /// @notice 방어 또는 USDG 대기 후 온체인 회복 추세가 확인되면 중앙 5틱으로 원자적 복귀한다.
    function resumeNormalAuto(int24 expectedTick, uint256 deadline)
        external
        onlyOperator
        nonReentrant
        returns (uint256 nextTokenId)
    {
        bool fromDefensive = mode == Mode.DEFENSIVE;
        if (!fromDefensive && mode != Mode.USDG_WAIT) revert InvalidMode();
        uint256 minimumWait = fromDefensive ? MIN_DEFENSIVE_DURATION : MIN_USDG_WAIT_DURATION;
        if (block.timestamp < uint256(modeChangedAt) + minimumWait) revert TrendNotConfirmed();
        _validateDeadline(deadline);
        (uint160 beforeSqrtPriceX96, int24 beforeTick) = _validatedMarketTick(expectedTick);
        if (!_recoveryConfirmed()) revert TrendNotConfirmed();
        _consumeRebalanceSlot();

        uint256 previousTokenId;
        int24 tickLower;
        int24 tickUpper;
        (previousTokenId, nextTokenId, tickLower, tickUpper) = _replacePosition(beforeSqrtPriceX96, beforeTick, deadline, false);
        defensiveAnchor = 0;
        _setMode(Mode.LIVE);
        emit NormalPositionResumed(previousTokenId, nextTokenId, tickLower, tickUpper);
    }

    /// @notice 거래정지 등 별도 안전상태에서 LP를 풀고 두 원물을 금고 안에 대기시킨다. 재민트는 하지 않는다.
    function withdrawToIdle(uint256 deadline) external onlySafetyOperator nonReentrant {
        _validateDeadline(deadline);
        uint256 tokenId = activeTokenId;
        if (tokenId == 0) revert InvalidPosition();
        _withdrawPosition(tokenId, deadline);
        activeTokenId = 0;
        _setMode(Mode.WITHDRAW_ONLY);
        _sendAll(UP, recipient);
        emit PositionIdled(tokenId, IERC20(SPCX).balanceOf(address(this)), IERC20(USDG).balanceOf(address(this)));
    }

    /// @notice 활성 또는 idle 자산을 스왑 없이 고정 recipient에게 돌려준다. keeper도 목적지를 바꿀 수 없다.
    function exitToTokens(uint256 deadline) external onlySafetyOperator nonReentrant {
        _validateDeadline(deadline);
        uint256 tokenId = activeTokenId;
        if (tokenId != 0) {
            _withdrawPosition(tokenId, deadline);
            activeTokenId = 0;
        }
        _setMode(Mode.WITHDRAW_ONLY);
        uint256 spcxAmount = _sendAll(SPCX, recipient);
        uint256 usdgAmount = _sendAll(USDG, recipient);
        _sendAll(UP, recipient);
        emit PositionExited(tokenId, false, spcxAmount, usdgAmount);
    }

    function harvestUp() external onlyOperator nonReentrant returns (uint256 amount) {
        uint256 tokenId = activeTokenId;
        if (tokenId == 0) revert InvalidPosition();
        ICLGauge(GAUGE).getReward(tokenId);
        amount = _sendAll(UP, recipient);
        totalHarvestedUp += amount;
        emit RewardHarvested(amount);
    }

    function strategyRange(int24 tick) public pure returns (int24 tickLower, int24 tickUpper) {
        int24 compressed = tick / TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) compressed -= 1;
        int24 anchor = compressed * TICK_SPACING;
        tickLower = anchor - (TICK_SPACING * 2);
        tickUpper = anchor + (TICK_SPACING * 3);
        if (tickUpper - tickLower != RANGE_WIDTH || tickLower % TICK_SPACING != 0 || tickUpper % TICK_SPACING != 0) {
            revert InvalidRange();
        }
    }

    function defensiveRange(int24 tick) public pure returns (int24 tickLower, int24 tickUpper) {
        int24 compressed = tick / TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) compressed -= 1;
        int24 anchor = compressed * TICK_SPACING;
        tickLower = anchor - (TICK_SPACING * 4);
        tickUpper = anchor + TICK_SPACING;
        if (tickUpper - tickLower != RANGE_WIDTH || tickLower % TICK_SPACING != 0 || tickUpper % TICK_SPACING != 0) {
            revert InvalidRange();
        }
    }

    function currentPosition()
        external
        view
        returns (uint256 tokenId, int24 tickLower, int24 tickUpper, uint128 liquidity, bool inRange)
    {
        tokenId = activeTokenId;
        if (tokenId == 0) return (0, 0, 0, 0, false);
        (,, address token0, address token1, int24 spacing, int24 lower, int24 upper, uint128 positionLiquidity,,,,) =
            IPositionManager(POSITION_MANAGER).positions(tokenId);
        if (token0 != SPCX || token1 != USDG || spacing != TICK_SPACING) revert InvalidPosition();
        int24 tick = _currentTick();
        return (tokenId, lower, upper, positionLiquidity, tick >= lower && tick < upper);
    }

    function rebalanceCounts() external view returns (uint256 inTenMinutes, uint256 inOneHour) {
        for (uint256 index; index < rebalanceHistory.length; ++index) {
            uint64 timestamp = rebalanceHistory[index];
            if (timestamp >= block.timestamp - 10 minutes) ++inTenMinutes;
            if (timestamp >= block.timestamp - 1 hours) ++inOneHour;
        }
    }

    /// @dev Position Manager/Gauge가 safeTransferFrom을 쓰는 구현에서도 수신 가능하게 하되, 작업 중 공식 NFT만 허용한다.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != POSITION_MANAGER || entered != 2) revert InvalidRoute();
        return this.onERC721Received.selector;
    }

    function _assertDeployment() internal view {
        if (
            ICLPool(POOL).token0() != SPCX || ICLPool(POOL).token1() != USDG || ICLPool(POOL).tickSpacing() != TICK_SPACING
                || ICLPool(POOL).gauge() != GAUGE || ICLPool(POOL).nft() != POSITION_MANAGER || ICLGauge(GAUGE).pool() != POOL
                || ICLGauge(GAUGE).nft() != POSITION_MANAGER || ICLGauge(GAUGE).token0() != SPCX || ICLGauge(GAUGE).token1() != USDG
                || ICLGauge(GAUGE).tickSpacing() != TICK_SPACING || ICLGauge(GAUGE).rewardToken() != UP
        ) revert InvalidRoute();
    }

    function _validatedMarketTick(int24 expectedTick) internal view returns (uint160 sqrtPriceX96, int24 tick) {
        return _validatedMarketTick(expectedTick, EXPECTED_TICK_TOLERANCE);
    }

    function _validatedMarketTick(int24 expectedTick, int24 tolerance) internal view returns (uint160 sqrtPriceX96, int24 tick) {
        uint16 cardinality;
        uint16 cardinalityNext;
        (sqrtPriceX96, tick,, cardinality, cardinalityNext,) = ICLPool(POOL).slot0();
        if (_tickDistance(tick, expectedTick) > tolerance) revert InvalidTick();
        if (cardinality < 2 || cardinalityNext < REQUIRED_ORACLE_CARDINALITY) revert OracleNotReady();
        uint32[] memory secondsAgos = new uint32[](3);
        secondsAgos[0] = 0;
        secondsAgos[1] = 30;
        secondsAgos[2] = 300;
        (int56[] memory cumulativeTicks,) = ICLPool(POOL).observe(secondsAgos);
        int24 twap30 = _arithmeticMeanTick(cumulativeTicks[0] - cumulativeTicks[1], 30);
        int24 twap300 = _arithmeticMeanTick(cumulativeTicks[0] - cumulativeTicks[2], 300);
        if (_tickDistance(tick, twap30) > SPOT_TWAP_30_MAX_TICKS || _tickDistance(twap30, twap300) > TWAP_30_300_MAX_TICKS) {
            revert PriceGuardFailed();
        }
    }

    /// @dev 진입 직전 TWAP 검증은 _validatedMarketTick에서 끝낸다. 이후 자체 스왑으로 움직인 spot을
    ///      TWAP과 다시 비교하면 정상적인 단일자산 진입도 자기 가격 충격 때문에 막히므로,
    ///      여기서는 풀 잠금과 직전 자체 스왑의 최대 이동폭만 다시 검증한다.
    function _validatedPostSwapTick(int24 expectedTick) internal view returns (uint160 sqrtPriceX96, int24 tick) {
        bool unlocked;
        (sqrtPriceX96, tick,,,, unlocked) = ICLPool(POOL).slot0();
        if (!unlocked || _tickDistance(tick, expectedTick) > SWAP_PRICE_LIMIT_TICKS) revert InvalidTick();
    }

    function _fiveMinuteCrashConfirmed() internal view returns (bool) {
        (, int24 tick,, uint16 cardinality, uint16 cardinalityNext,) = ICLPool(POOL).slot0();
        if (cardinality < 2 || cardinalityNext < REQUIRED_ORACLE_CARDINALITY) revert OracleNotReady();
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = 0;
        secondsAgos[1] = 300;
        (int56[] memory cumulativeTicks,) = ICLPool(POOL).observe(secondsAgos);
        int24 twap300 = _arithmeticMeanTick(cumulativeTicks[0] - cumulativeTicks[1], 300);
        // 선형 5분 -3% 하락이면 현재 틱은 5분 평균보다 약 305/2틱 낮다.
        // Keeper의 실제 5분 endpoint -3% 확인과 함께 써서 직전 5분 창이 다
        // 채워질 때까지 기다리지 않되 단일 spot만으로는 실행하지 않는다.
        return tick <= twap300 - FIVE_MINUTE_CRASH_TICKS / 2;
    }

    function _slowDowntrendConfirmed(int24 currentTick) internal view returns (bool) {
        uint32[] memory secondsAgos = new uint32[](3);
        secondsAgos[0] = 0;
        secondsAgos[1] = 900;
        secondsAgos[2] = 1800;
        (int56[] memory cumulativeTicks,) = ICLPool(POOL).observe(secondsAgos);
        int24 twap900 = _arithmeticMeanTick(cumulativeTicks[0] - cumulativeTicks[1], 900);
        int24 twap1800 = _arithmeticMeanTick(cumulativeTicks[0] - cumulativeTicks[2], 1800);
        return currentTick <= twap900 - SLOW_DROP_15_TWAP_TICKS && currentTick <= twap1800 - SLOW_DROP_30_TWAP_TICKS;
    }

    function _recoveryConfirmed() internal view returns (bool) {
        uint32[] memory secondsAgos = new uint32[](4);
        secondsAgos[0] = 0;
        secondsAgos[1] = 900;
        secondsAgos[2] = 1800;
        secondsAgos[3] = 3600;
        (int56[] memory cumulativeTicks,) = ICLPool(POOL).observe(secondsAgos);
        int24 recent15 = _arithmeticMeanTick(cumulativeTicks[0] - cumulativeTicks[1], 900);
        int24 previous15 = _arithmeticMeanTick(cumulativeTicks[1] - cumulativeTicks[2], 900);
        int24 recent30 = _arithmeticMeanTick(cumulativeTicks[0] - cumulativeTicks[2], 1800);
        int24 previous30 = _arithmeticMeanTick(cumulativeTicks[2] - cumulativeTicks[3], 1800);
        return recent15 >= previous15 + RECOVERY_15_TWAP_TICKS && recent30 >= previous30;
    }

    function _arithmeticMeanTick(int56 delta, int56 secondsDelta) internal pure returns (int24 tick) {
        int56 quotient = delta / secondsDelta;
        if (delta < 0 && delta % secondsDelta != 0) --quotient;
        tick = int24(quotient);
    }

    function _tickDistance(int24 a, int24 b) internal pure returns (int24) {
        return a >= b ? a - b : b - a;
    }

    function _currentTick() internal view returns (int24 tick) {
        (, tick,,,,) = ICLPool(POOL).slot0();
    }

    function _validateExpectedTick(int24 currentTick, int24 expectedTick) internal pure {
        if (_tickDistance(currentTick, expectedTick) > EXPECTED_TICK_TOLERANCE) revert InvalidTick();
    }

    function _validateDeadline(uint256 deadline) internal view {
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_DEADLINE_DELAY) revert InvalidDeadline();
    }

    function _validateStartDeadline(uint256 deadline) internal view {
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_START_DEADLINE_DELAY) revert InvalidDeadline();
    }

    function _consumeRebalanceSlot() internal {
        if (lastRebalanceAt != 0 && block.timestamp < uint256(lastRebalanceAt) + MIN_REBALANCE_INTERVAL) revert RateLimited();
        uint256 inTenMinutes;
        uint256 inOneHour;
        for (uint256 index; index < rebalanceHistory.length; ++index) {
            uint64 timestamp = rebalanceHistory[index];
            if (timestamp >= block.timestamp - 10 minutes) ++inTenMinutes;
            if (timestamp >= block.timestamp - 1 hours) ++inOneHour;
        }
        if (inTenMinutes >= MAX_REBALANCES_10_MIN || inOneHour >= MAX_REBALANCES_1_HOUR) revert RateLimited();
        uint64 nowTimestamp = uint64(block.timestamp);
        rebalanceHistory[rebalanceCursor] = nowTimestamp;
        rebalanceCursor = uint8((rebalanceCursor + 1) % rebalanceHistory.length);
        lastRebalanceAt = nowTimestamp;
    }

    function _withdrawPosition(uint256 tokenId, uint256 deadline) internal {
        ICLGauge(GAUGE).withdraw(tokenId);
        (,, address token0, address token1, int24 spacing,,, uint128 liquidity,,,,) =
            IPositionManager(POSITION_MANAGER).positions(tokenId);
        if (token0 != SPCX || token1 != USDG || spacing != TICK_SPACING) revert InvalidPosition();
        if (liquidity != 0) {
            IPositionManager(POSITION_MANAGER).decreaseLiquidity(
                IPositionManager.DecreaseLiquidityParams({
                    tokenId: tokenId,
                    liquidity: liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: deadline
                })
            );
        }
        IPositionManager(POSITION_MANAGER).collect(
            IPositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        IPositionManager(POSITION_MANAGER).burn(tokenId);
    }

    function _replacePosition(uint160 sqrtPriceX96, int24 tick, uint256 deadline, bool defensive)
        internal
        returns (uint256 previousTokenId, uint256 nextTokenId, int24 tickLower, int24 tickUpper)
    {
        previousTokenId = activeTokenId;
        if (previousTokenId != 0) _withdrawPosition(previousTokenId, deadline);
        activeTokenId = 0;
        (nextTokenId, tickLower, tickUpper) = _balanceMintAndStake(sqrtPriceX96, tick, deadline, defensive);
        activeTokenId = nextTokenId;
        unchecked {
            ++totalRebalances;
        }
        _sendAll(UP, recipient);
        emit PositionRebalanced(previousTokenId, nextTokenId, tickLower, tickUpper);
    }

    function _balanceMintAndStake(
        uint160 beforeSqrtPriceX96,
        int24 beforeTick,
        uint256 deadline,
        bool defensive
    )
        internal
        returns (uint256 tokenId, int24 tickLower, int24 tickUpper)
    {
        uint160 currentSqrtPriceX96 = beforeSqrtPriceX96;
        int24 currentTick = beforeTick;
        uint160 referenceSqrtPriceX96 = _twapSqrtPriceX96(30);
        address previousTokenIn;
        uint256 spcxBalance;
        uint256 usdgBalance;
        for (uint256 pass; pass < MAX_BALANCE_PASSES; ++pass) {
            spcxBalance = IERC20(SPCX).balanceOf(address(this));
            usdgBalance = IERC20(USDG).balanceOf(address(this));
            (tickLower, tickUpper) = defensive ? defensiveRange(currentTick) : strategyRange(currentTick);
            (address nextTokenIn, uint256 nextAmountIn) =
                _balanceSwapAmount(spcxBalance, usdgBalance, currentSqrtPriceX96, tickLower, tickUpper);
            if (nextAmountIn == 0) break;
            // 좁은 범위에서 목표 비율을 지나쳐 스왑 방향이 뒤집히면 절반만 보정해 수렴시킨다.
            if (previousTokenIn != address(0) && previousTokenIn != nextTokenIn) nextAmountIn /= 2;
            if (nextAmountIn == 0) break;
            uint256 totalValueUsdg = usdgBalance + _quoteToken0To1(spcxBalance, currentSqrtPriceX96);
            uint256 nextValueUsdg = nextTokenIn == USDG
                ? nextAmountIn
                : _quoteToken0To1(nextAmountIn, currentSqrtPriceX96);
            if (nextValueUsdg * BPS <= totalValueUsdg * BALANCE_STOP_BPS) break;
            _swapExactIn(nextTokenIn, nextAmountIn, referenceSqrtPriceX96, currentTick, false, deadline);
            previousTokenIn = nextTokenIn;
            // 첫 expectedTick은 외부 시세 변동을 막는다. 이후에는 바로 전 검증 틱을 기준으로
            // 각 자체 스왑은 30틱 이내로 제한하고, 전체 이동은 같은 함수의 TWAP 가드가 35틱으로 제한한다.
            (currentSqrtPriceX96, currentTick) = _validatedPostSwapTick(currentTick);
        }

        (tickLower, tickUpper) = defensive ? defensiveRange(currentTick) : strategyRange(currentTick);
        spcxBalance = IERC20(SPCX).balanceOf(address(this));
        usdgBalance = IERC20(USDG).balanceOf(address(this));
        if (spcxBalance == 0 || usdgBalance == 0) revert InvalidPosition();
        tokenId = _mintAndStake(tickLower, tickUpper, spcxBalance, usdgBalance, deadline);
    }

    function _balanceSwapAmount(
        uint256 amount0,
        uint256 amount1,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper
    ) internal view returns (address tokenIn, uint256 amountIn) {
        uint160 sqrtLowerX96 = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtUpperX96 = TickMath.getSqrtRatioAtTick(tickUpper);
        if (sqrtPriceX96 <= sqrtLowerX96 || sqrtPriceX96 >= sqrtUpperX96) revert InvalidRange();

        // 최적 LP 비율 amount1 / amount0을 Q96으로 계산한다.
        uint256 ratio1Per0X96 = FullMath.mulDiv(sqrtPriceX96, sqrtUpperX96, Q96);
        ratio1Per0X96 = FullMath.mulDiv(ratio1Per0X96, sqrtPriceX96 - sqrtLowerX96, sqrtUpperX96 - sqrtPriceX96);
        uint256 target1 = FullMath.mulDiv(amount0, ratio1Per0X96, Q96);
        uint24 poolFee = ICLPool(POOL).fee();
        if (poolFee > MAX_POOL_FEE_PIPS) revert InvalidSlippage();
        uint256 feeFactor = FEE_PIPS - poolFee;
        uint256 spotPriceX96 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, Q96);

        if (target1 > amount1) {
            uint256 effectivePriceX96 = FullMath.mulDiv(spotPriceX96, feeFactor, FEE_PIPS);
            amountIn = FullMath.mulDiv(target1 - amount1, Q96, ratio1Per0X96 + effectivePriceX96);
            tokenIn = SPCX;
            if (amountIn >= amount0) revert InvalidPosition();
        } else if (amount1 > target1) {
            uint256 token0Per1X96 = FullMath.mulDiv(Q96, Q96, spotPriceX96);
            token0Per1X96 = FullMath.mulDiv(token0Per1X96, feeFactor, FEE_PIPS);
            uint256 ratioTimesConversionX96 = FullMath.mulDiv(ratio1Per0X96, token0Per1X96, Q96);
            amountIn = FullMath.mulDiv(amount1 - target1, Q96, Q96 + ratioTimesConversionX96);
            tokenIn = USDG;
            if (amountIn >= amount1) revert InvalidPosition();
        }

        // SPCX는 18 decimals, USDG는 6 decimals다. USDG 쪽에 18-decimal dust 기준을
        // 적용하면 큰 입금에서 정상 자산이 스왑되지 않으므로 토큰별 단위를 사용한다.
        if ((tokenIn == SPCX && amountIn < 1_000_000_000) || (tokenIn == USDG && amountIn < 1)) {
            return (address(0), 0);
        }
    }

    function _mintAndStake(
        int24 tickLower,
        int24 tickUpper,
        uint256 amountSpcxDesired,
        uint256 amountUsdgDesired,
        uint256 deadline
    ) internal returns (uint256 tokenId) {
        _forceApprove(SPCX, POSITION_MANAGER, amountSpcxDesired);
        _forceApprove(USDG, POSITION_MANAGER, amountUsdgDesired);
        uint256 amountSpcxUsed;
        uint256 amountUsdgUsed;
        (tokenId,, amountSpcxUsed, amountUsdgUsed) = IPositionManager(POSITION_MANAGER).mint(
            IPositionManager.MintParams({
                token0: SPCX,
                token1: USDG,
                tickSpacing: TICK_SPACING,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amountSpcxDesired,
                amount1Desired: amountUsdgDesired,
                // 토큰별 최소량은 좁은 범위에서 한쪽 잔액만으로 PSC를 일으킨다.
                // 민트 후 두 잔액을 같은 USDG 가치로 환산해 아래에서 원자적으로 검증한다.
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: deadline,
                // The pool already exists. Slipstream NPM treats a non-zero value as
                // createPool(), which reverts for this existing SPCX/USDG pool.
                sqrtPriceX96: 0
            })
        );
        if (amountSpcxUsed > amountSpcxDesired || amountUsdgUsed > amountUsdgDesired) revert InvalidPosition();
        (uint160 mintSqrtPriceX96,,,,,) = ICLPool(POOL).slot0();
        uint256 desiredValueUsdg = amountUsdgDesired + _quoteToken0To1(amountSpcxDesired, mintSqrtPriceX96);
        uint256 unusedValueUsdg = amountUsdgDesired - amountUsdgUsed
            + _quoteToken0To1(amountSpcxDesired - amountSpcxUsed, mintSqrtPriceX96);
        if (unusedValueUsdg * BPS > desiredValueUsdg * MAX_UNUSED_BPS) {
            revert IdleBalanceTooHigh(unusedValueUsdg, desiredValueUsdg);
        }
        _forceApprove(SPCX, POSITION_MANAGER, 0);
        _forceApprove(USDG, POSITION_MANAGER, 0);
        IPositionManager(POSITION_MANAGER).approve(GAUGE, tokenId);
        ICLGauge(GAUGE).deposit(tokenId);
    }

    function _swapVaultSpcxToUsdg(int24 tick, uint256 deadline) internal returns (uint256 amountOut) {
        uint256 amountIn = IERC20(SPCX).balanceOf(address(this));
        if (amountIn == 0) return 0;
        amountOut = _swapExactIn(SPCX, amountIn, _twapSqrtPriceX96(300), tick, true, deadline);
        uint256 remainingSpcx = IERC20(SPCX).balanceOf(address(this));
        if (remainingSpcx >= 1e9) revert EmergencySwapIncomplete(remainingSpcx);
    }

    function _swapExactIn(
        address tokenIn,
        uint256 amountIn,
        uint160 referenceSqrtPriceX96,
        int24 currentTick,
        bool emergency,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        address tokenOut;
        uint256 spotQuote;
        if (tokenIn == SPCX) {
            tokenOut = USDG;
            spotQuote = _quoteToken0To1(amountIn, referenceSqrtPriceX96);
        } else if (tokenIn == USDG && !emergency) {
            tokenOut = SPCX;
            spotQuote = _quoteToken1To0(amountIn, referenceSqrtPriceX96);
        } else {
            revert InvalidRoute();
        }
        uint256 slippageBps = emergency ? EMERGENCY_SLIPPAGE_BPS : NORMAL_SLIPPAGE_BPS;
        uint256 amountOutMinimum = spotQuote * (BPS - slippageBps) / BPS;
        uint160 sqrtPriceLimitX96 = _priceLimit(tokenIn, currentTick, emergency);
        _forceApprove(tokenIn, SWAP_ROUTER, amountIn);
        amountOut = ISwapRouter(SWAP_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                tickSpacing: TICK_SPACING,
                recipient: address(this),
                deadline: deadline,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: sqrtPriceLimitX96
            })
        );
        _forceApprove(tokenIn, SWAP_ROUTER, 0);
    }

    function _priceLimit(address tokenIn, int24 currentTick, bool emergency) internal pure returns (uint160) {
        if (tokenIn == SPCX) {
            int24 movement = emergency ? int24(101) : SWAP_PRICE_LIMIT_TICKS;
            int24 limitTick = currentTick - movement;
            if (limitTick <= TickMath.MIN_TICK) limitTick = TickMath.MIN_TICK + 1;
            return TickMath.getSqrtRatioAtTick(limitTick);
        }
        if (tokenIn == USDG && !emergency) {
            int24 limitTick = currentTick + SWAP_PRICE_LIMIT_TICKS;
            if (limitTick >= TickMath.MAX_TICK) limitTick = TickMath.MAX_TICK - 1;
            return TickMath.getSqrtRatioAtTick(limitTick);
        }
        revert InvalidRoute();
    }

    function _quoteToken0To1(uint256 amount0, uint160 sqrtPriceX96) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(amount0, sqrtPriceX96, Q96), sqrtPriceX96, Q96);
    }

    function _quoteToken1To0(uint256 amount1, uint160 sqrtPriceX96) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(amount1, Q96, sqrtPriceX96), Q96, sqrtPriceX96);
    }

    function _twapSqrtPriceX96(uint32 secondsAgo) internal view returns (uint160) {
        (,,, uint16 cardinality, uint16 cardinalityNext,) = ICLPool(POOL).slot0();
        if (cardinality < 2 || cardinalityNext < REQUIRED_ORACLE_CARDINALITY) revert OracleNotReady();
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = 0;
        secondsAgos[1] = secondsAgo;
        (int56[] memory cumulativeTicks,) = ICLPool(POOL).observe(secondsAgos);
        int24 twap = _arithmeticMeanTick(cumulativeTicks[0] - cumulativeTicks[1], int56(uint56(secondsAgo)));
        return TickMath.getSqrtRatioAtTick(twap);
    }

    function _setMode(Mode nextMode) internal {
        Mode previous = mode;
        mode = nextMode;
        modeChangedAt = uint64(block.timestamp);
        emit ModeChanged(previous, nextMode, msg.sender);
    }

    function _sendAll(address token, address to) internal returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount != 0) _safeTransfer(token, to, amount);
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _forceApprove(address token, address spender, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (success && (data.length == 0 || abi.decode(data, (bool)))) return;
        (success, data) = token.call(abi.encodeCall(IERC20.approve, (spender, 0)));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        (success, data) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ICLPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function gauge() external view returns (address);
    function nft() external view returns (address);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            bool unlocked
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

interface ICLGauge {
    function pool() external view returns (address);
    function nft() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function tickSpacing() external view returns (int24);
    function rewardToken() external view returns (address);
    function deposit(uint256 tokenId) external;
    function withdraw(uint256 tokenId) external;
    function getReward(uint256 tokenId) external;
}

interface IPositionManager {
    struct MintParams {
        address token0;
        address token1;
        int24 tickSpacing;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
        uint160 sqrtPriceX96;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            int24 tickSpacing,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function burn(uint256 tokenId) external payable;
    function approve(address to, uint256 tokenId) external;
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev Uniswap V3 TickMath의 getSqrtRatioAtTick 경로. GPL-2.0-or-later.
library TickMath {
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = -MIN_TICK;
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(uint24(-tick)) : uint256(uint24(tick));
            require(absTick <= uint256(uint24(MAX_TICK)));
            uint256 ratio = absTick & 0x1 != 0
                ? 0xfffcb933bd6fad37aa2d162d1a594001
                : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
            if (tick > 0) ratio = type(uint256).max / ratio;
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}

/// @dev Uniswap V3 FullMath. GPL-2.0-or-later.
library FullMath {
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly ("memory-safe") {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) return prod0 / denominator;
            require(denominator > prod1);
            uint256 remainder;
            assembly ("memory-safe") {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = denominator & (~denominator + 1);
            assembly ("memory-safe") {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            result = prod0 * inverse;
            return result;
        }
    }
}

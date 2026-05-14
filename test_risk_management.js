const scannerService = require('./scannerService');
const supabaseService = require('./supabaseService');

// Very basic jest.fn mock implementation for manual testing
function jest_fn() {
    let mockResolver = null;
    const fn = async () => mockResolver;
    fn.mockResolvedValue = (val) => { mockResolver = val; };
    return fn;
}
global.jest = { fn: jest_fn };

// Mock dependencies
supabaseService.getInvestedCapital = jest.fn();
supabaseService.getUserSettings = jest.fn();
supabaseService.getPaperFunds = jest.fn();

const MOCK_USER_ID = 'test-user';
const MOCK_PRICE = 1000;
const MOCK_SL = 950;

async function runTests() {
    console.log('--- Testing Risk Management Logic ---');
    
    // Test 1: Normal Allocation (Enough Capital)
    supabaseService.getPaperFunds.mockResolvedValue(100000);
    supabaseService.getInvestedCapital.mockResolvedValue(0);
    supabaseService.getUserSettings.mockResolvedValue({
        max_utilization_pct: 60, // Max 60,000
        min_allocation_pct: 10,  // Min 10,000 per stock
        max_allocation_pct: 20,  // Target 20,000 per stock
        risk_per_trade: 1        // Risk 1000 total
    });
    // With 100000 total: Target Alloc is 20000 -> qty = 20. Risk allows qty = 1000/50 = 20.
    // Result should be 20.
    let qty = await scannerService.calculateQuantity(MOCK_USER_ID, MOCK_PRICE, MOCK_SL, 'PAPER');
    console.log(`Test 1 (Normal): Expected ~20, Got: ${qty}`);

    // Test 2: Nearing Max Utilization (Cap applied)
    supabaseService.getInvestedCapital.mockResolvedValue(55000); // 55k invested
    supabaseService.getPaperFunds.mockResolvedValue(45000);      // 45k free cash
    // TotalCap = 100k. Max Allowed = 60k. Remaining = 5k.
    // Price = 1000. Max Qty = 5.
    qty = await scannerService.calculateQuantity(MOCK_USER_ID, MOCK_PRICE, MOCK_SL, 'PAPER');
    console.log(`Test 2 (Nearing Cap): Expected ~5, Got: ${qty}`);

    // Test 3: Over Max Utilization (No trades allowed)
    supabaseService.getInvestedCapital.mockResolvedValue(65000); // 65k invested
    supabaseService.getPaperFunds.mockResolvedValue(35000);      // 35k free cash
    // TotalCap = 100k. Max Allowed = 60k.
    // Invested 65k >= 60k. Should return 0.
    qty = await scannerService.calculateQuantity(MOCK_USER_ID, MOCK_PRICE, MOCK_SL, 'PAPER');
    console.log(`Test 3 (Over Cap): Expected 0, Got: ${qty}`);
    
    console.log('--- Tests Completed ---');
}

runTests();

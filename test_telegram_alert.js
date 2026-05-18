const telegramService = require('./telegramService');

async function test() {
    await telegramService.sendMessage("Test from backend");
}

test();

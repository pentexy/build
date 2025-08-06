const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const { Vec3 } = require('vec3');
const nbt = require('prismarine-nbt');
const fs = require('fs');
const mcDataLoader = require('minecraft-data');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// Configuration
const CONFIG = {
    host: '18.143.129.103',
    port: 25565,
    username: 'BuilderBot',
    buildDelay: 200,
    schematicUrl: 'https://files.catbox.moe/r7z2gh.nbt',
    waitTime: 30000 // 30 seconds to get items
};

const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username
});

bot.loadPlugin(pathfinder);

const state = {
    chestPos: null,
    buildPos: null,
    structure: null,
    requiredItems: {},
    isBuilding: false,
    inventoryCache: {}
};

// Helper functions
const log = (message) => {
    console.log(`[BuilderBot] ${message}`);
    bot.chat(message);
};

const getBlockName = (state) => {
    return state.Name.value.split(':')[1] || state.Name.value;
};

const scanInventory = () => {
    state.inventoryCache = {};
    bot.inventory.items().forEach(item => {
        state.inventoryCache[item.name] = (state.inventoryCache[item.name] || 0) + item.count;
    });
};

const goToPosition = async (position) => {
    const mcData = mcDataLoader(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalNear(position.x, position.y, position.z, 1));
    
    await new Promise((resolve) => {
        const checkArrival = setInterval(() => {
            if (bot.entity.position.distanceTo(position) < 2) {
                clearInterval(checkArrival);
                resolve();
            }
        }, 500);
    });
};

const downloadSchematic = async () => {
    try {
        log('Downloading schematic...');
        const res = await fetch(CONFIG.schematicUrl);
        const buffer = await res.buffer();
        fs.writeFileSync('schematic.nbt', buffer);
        
        const data = await nbt.parse(buffer);
        state.structure = data.parsed.value;

        // Calculate required items
        state.requiredItems = {};
        state.structure.blocks.value.value.forEach(block => {
            const blockState = state.structure.palette.value.value[block.state.value];
            const name = getBlockName(blockState);
            state.requiredItems[name] = (state.requiredItems[name] || 0) + 1;
        });

        log('Schematic loaded successfully');
    } catch (err) {
        log(`Failed to load schematic: ${err.message}`);
    }
};

const getMissingItems = () => {
    scanInventory();
    const missing = {};
    
    for (const [name, needed] of Object.entries(state.requiredItems)) {
        const have = state.inventoryCache[name] || 0;
        if (have < needed) {
            missing[name] = needed - have;
        }
    }
    
    return missing;
};

const manageChestItems = async () => {
    if (!state.chestPos) return false;

    try {
        // Go to chest
        await goToPosition(state.chestPos);
        
        // Open chest
        const chestBlock = bot.blockAt(state.chestPos);
        if (!chestBlock) {
            log('No chest found at location');
            return false;
        }
        
        const chest = await bot.openChest(chestBlock);
        
        // Deposit all items first to organize
        for (const item of bot.inventory.items()) {
            await chest.deposit(item.type, null, item.count);
        }
        
        // Withdraw exactly what we need
        const missing = getMissingItems();
        for (const [name, amount] of Object.entries(missing)) {
            const items = chest.items().filter(i => i.name === name);
            if (items.length > 0) {
                await chest.withdraw(items[0].type, null, Math.min(amount, items[0].count));
            }
        }
        
        await chest.close();
        return true;
    } catch (err) {
        log(`Chest error: ${err.message}`);
        return false;
    }
};

const buildStructure = async () => {
    if (state.isBuilding) return;
    state.isBuilding = true;

    try {
        if (!state.buildPos || !state.structure) {
            throw new Error('Set build position and load schematic first');
        }

        // 1. Go to chest first if set
        if (state.chestPos) {
            log('Organizing items at chest...');
            await manageChestItems();
        }

        // 2. Check if we have all items
        const missing = getMissingItems();
        if (Object.keys(missing).length > 0) {
            log('Still missing some items, waiting...');
            log('Please put these in the chest or give to bot:');
            for (const [item, amount] of Object.entries(missing)) {
                log(`${item}: ${amount}`);
            }
            await sleep(CONFIG.waitTime);
        }

        // 3. Go to build location
        await goToPosition(state.buildPos);

        // 4. Start building
        log('Starting to build...');
        const blocks = state.structure.blocks.value.value;
        const palette = state.structure.palette.value.value;

        for (const block of blocks) {
            if (!state.isBuilding) break;

            const blockState = palette[block.state.value];
            const blockName = getBlockName(blockState);
            const position = new Vec3(
                block.pos.value[0] + state.buildPos.x,
                block.pos.value[1] + state.buildPos.y,
                block.pos.value[2] + state.buildPos.z
            );

            const item = bot.inventory.items().find(i => i.name === blockName);
            if (!item) {
                log(`Missing ${blockName}, getting more...`);
                if (state.chestPos) {
                    await manageChestItems();
                    await goToPosition(state.buildPos);
                }
                continue;
            }

            try {
                await bot.equip(item, 'hand');
                await bot.placeBlock(bot.blockAt(position), new Vec3(0, 1, 0));
                await sleep(CONFIG.buildDelay);
            } catch (err) {
                log(`Building error: ${err.message}`);
            }
        }

        log('Build complete!');
    } catch (err) {
        log(`Build failed: ${err.message}`);
    } finally {
        state.isBuilding = false;
    }
};

// Event handlers
bot.once('spawn', async () => {
    log('Bot ready!');
    await downloadSchematic();
});

bot.on('chat', (username, message) => {
    if (username === bot.username) return;

    const args = message.trim().split(' ');
    const cmd = args[0].toLowerCase();

    (async () => {
        try {
            switch (cmd) {
                case '!setchest':
                    if (args.length === 4) {
                        state.chestPos = new Vec3(+args[1], +args[2], +args[3]);
                        log(`Chest location set`);
                    }
                    break;

                case '!come':
                    if (args.length === 4) {
                        state.buildPos = new Vec3(+args[1], +args[2], +args[3]);
                        await goToPosition(state.buildPos);
                        log(`At build location`);
                    }
                    break;

                case '!build':
                    await buildStructure();
                    break;

                case '!stop':
                    state.isBuilding = false;
                    log('Stopped building');
                    break;

                case '!materials':
                    log('Required materials:');
                    Object.entries(state.requiredItems).forEach(([name, count]) => {
                        log(`${name}: ${count}`);
                    });
                    break;
            }
        } catch (err) {
            log(`Error: ${err.message}`);
        }
    })();
});

// For Node.js <18
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Error handling
bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Kicked: ${reason}`));
bot.on('end', reason => log(`Disconnected: ${reason}`));            log('At chest location. Please provide items or put them in chest.');
            requestMissingItems();
            await sleep(10000); // Wait 10 seconds for items
        } else {
            requestMissingItems();
        }

        // 2. Go to build location
        log('Going to build location...');
        await goToPosition(state.buildPos);

        // 3. Start building
        log('Starting to build...');
        const blocks = state.structure.blocks.value.value;
        const palette = state.structure.palette.value.value;

        for (const block of blocks) {
            if (!state.isBuilding) break;

            const blockState = palette[block.state.value];
            const blockName = getBlockName(blockState);
            const position = new Vec3(
                block.pos.value[0] + state.buildPos.x,
                block.pos.value[1] + state.buildPos.y,
                block.pos.value[2] + state.buildPos.z
            );

            const item = bot.inventory.items().find(i => i.name === blockName);
            if (!item) {
                log(`Missing ${blockName}, returning to chest...`);
                if (state.chestPos) {
                    await goToPosition(state.chestPos);
                    requestMissingItems();
                    await sleep(10000); // Wait 10 seconds for items
                    await goToPosition(state.buildPos);
                } else {
                    requestMissingItems();
                    await sleep(10000);
                }
                continue;
            }

            try {
                await bot.equip(item, 'hand');
                await bot.placeBlock(bot.blockAt(position), new Vec3(0, 1, 0));
                await sleep(CONFIG.buildDelay);
            } catch (err) {
                log(`Building error: ${err.message}`);
            }
        }

        log('Build complete!');
    } catch (err) {
        log(`Build failed: ${err.message}`);
    } finally {
        state.isBuilding = false;
    }
};

// Event handlers
bot.once('spawn', async () => {
    log('Bot ready!');
    await downloadSchematic();
});

bot.on('chat', (username, message) => {
    if (username === bot.username) return;

    const args = message.trim().split(' ');
    const cmd = args[0].toLowerCase();

    (async () => {
        try {
            switch (cmd) {
                case '!setchest':
                    if (args.length === 4) {
                        state.chestPos = new Vec3(+args[1], +args[2], +args[3]);
                        log(`Chest location set at ${state.chestPos}`);
                    }
                    break;

                case '!come':
                    if (args.length === 4) {
                        state.buildPos = new Vec3(+args[1], +args[2], +args[3]);
                        await goToPosition(state.buildPos);
                        log(`Arrived at build location ${state.buildPos}`);
                    }
                    break;

                case '!build':
                    await buildStructure();
                    break;

                case '!stop':
                    state.isBuilding = false;
                    log('Stopped building');
                    break;

                case '!materials':
                    log('Required materials:');
                    Object.entries(state.requiredItems).forEach(([name, count]) => {
                        log(`- ${name}: ${count}`);
                    });
                    break;
            }
        } catch (err) {
            log(`Error: ${err.message}`);
        }
    })();
});

// For Node.js <18
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Error handling
bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Kicked: ${reason}`));
bot.on('end', reason => log(`Disconnected: ${reason}`));

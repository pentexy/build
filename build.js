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
    waitTime: 30000, // 30 seconds to get items
    maxRetries: 3
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
    
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            log('Pathfinding to position timed out.');
            bot.pathfinder.stop();
            reject(new Error('Pathfinding timeout'));
        }, 15000); // 15-second timeout

        const checkArrival = setInterval(() => {
            if (!bot.pathfinder.isMoving()) {
                clearInterval(checkArrival);
                clearTimeout(timeout);
                if (bot.entity.position.distanceTo(position) < 2) {
                    resolve();
                } else {
                    reject(new Error('Failed to reach destination.'));
                }
            }
        }, 500);
    });
};

const downloadSchematic = async () => {
    try {
        log('Downloading schematic...');
        const res = await fetch(CONFIG.schematicUrl);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const buffer = await res.buffer();
        fs.writeFileSync('schematic.nbt', buffer);
        
        const data = await nbt.parse(buffer);
        state.structure = data.parsed.value;

        state.requiredItems = {};
        state.structure.blocks.value.value.forEach(block => {
            const blockState = state.structure.palette.value.value[block.state.value];
            const name = getBlockName(blockState);
            if (name !== 'air') {
                state.requiredItems[name] = (state.requiredItems[name] || 0) + 1;
            }
        });

        log('Schematic loaded successfully. Use !materials to see requirements.');
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
        await goToPosition(state.chestPos);
        
        const chestBlock = bot.blockAt(state.chestPos);
        if (!chestBlock || chestBlock.name !== 'chest') {
            log('No chest found at location');
            return false;
        }
        
        const chest = await bot.openChest(chestBlock);
        
        // Deposit all items first
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
        log('Inventory synchronized with chest.');
        return true;
    } catch (err) {
        log(`Chest error: ${err.message}`);
        return false;
    }
};

const buildStructure = async () => {
    if (state.isBuilding) return;
    state.isBuilding = true;
    let retries = 0;

    try {
        if (!state.buildPos || !state.structure) {
            throw new Error('Set build position and load schematic first. Use !come x y z and then !build.');
        }

        while (retries < CONFIG.maxRetries) {
            if (!state.isBuilding) break;

            // 1. Get items from chest
            if (state.chestPos) {
                log('Organizing items at chest...');
                await manageChestItems();
            }

            // 2. Check if we have all items
            const missing = getMissingItems();
            if (Object.keys(missing).length > 0) {
                log('Still missing some items, waiting for players...');
                log('Please place these in the chest:');
                for (const [item, amount] of Object.entries(missing)) {
                    log(`${item}: ${amount}`);
                }
                await sleep(CONFIG.waitTime);
                retries++;
                continue;
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
                if (blockName === 'air') continue;

                const position = new Vec3(
                    block.pos.value[0] + state.buildPos.x,
                    block.pos.value[1] + state.buildPos.y,
                    block.pos.value[2] + state.buildPos.z
                );
                
                // Get the block that is currently there
                const existingBlock = bot.blockAt(position);
                if (existingBlock && existingBlock.name === blockName) {
                    continue; // Skip if the block is already placed
                }

                const item = bot.inventory.findInventoryItem(mcData.blocksByName[blockName].id, null, false);
                if (!item) {
                    log(`Ran out of ${blockName}, returning to chest.`);
                    break; // Break the loop to go get more items
                }

                try {
                    await bot.equip(item, 'hand');
                    const referenceBlock = bot.blockAt(position.minus(new Vec3(0, 1, 0))); // Place on block below
                    await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
                    await sleep(CONFIG.buildDelay);
                } catch (err) {
                    log(`Building error at ${position.x},${position.y},${position.z}: ${err.message}`);
                    await sleep(1000); // Wait a second before trying again
                }
            }

            if (getMissingItems().length === 0) {
                 log('Build complete!');
                 break;
            }

            log('Part of the build completed or ran out of items. Re-checking...');
        }

        if (retries >= CONFIG.maxRetries) {
            log('Build failed due to missing materials after multiple retries.');
        }

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
                        log(`Chest location set to ${state.chestPos.x}, ${state.chestPos.y}, ${state.chestPos.z}`);
                    } else {
                         log('Usage: !setchest <x> <y> <z>');
                    }
                    break;

                case '!come':
                    if (args.length === 4) {
                        state.buildPos = new Vec3(+args[1], +args[2], +args[3]);
                        log(`Going to build location ${state.buildPos.x}, ${state.buildPos.y}, ${state.buildPos.z}`);
                        await goToPosition(state.buildPos);
                        log('Arrived at build location');
                    } else {
                         log('Usage: !come <x> <y> <z>');
                    }
                    break;

                case '!build':
                    if (!state.buildPos) {
                        log('Please set the build location first using !come <x> <y> <z>');
                    } else {
                         await buildStructure();
                    }
                    break;

                case '!stop':
                    state.isBuilding = false;
                    log('Stopped building');
                    break;

                case '!materials':
                    if (Object.keys(state.requiredItems).length > 0) {
                        log('Required materials:');
                        const missing = getMissingItems();
                        for (const [name, count] of Object.entries(state.requiredItems)) {
                             const have = state.inventoryCache[name] || 0;
                             const status = have >= count ? '✅' : `❌ (need ${count - have})`;
                             log(`${name}: ${count} ${status}`);
                        }
                    } else {
                        log('Schematic not loaded or has no blocks.');
                    }
                    break;

                case '!help':
                    log('Available commands: !setchest <x y z>, !come <x y z>, !build, !stop, !materials, !help');
                    break;
            }
        } catch (err) {
            log(`Command error: ${err.message}`);
        }
    })();
});

// For Node.js <18
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Error handling
bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Kicked: ${reason}`));
bot.on('end', reason => log(`Disconnected: ${reason}`));

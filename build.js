const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock } = goals;
const { Vec3 } = require('vec3');
const nbt = require('prismarine-nbt');
const fs = require('fs');
const mcDataLoader = require('minecraft-data');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// For Node.js <18
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Configuration
const CONFIG = {
    host: 'unholy-engraved.ap.e4mc.link',
    port: 25565,
    username: 'BuilderBot',
    buildDelay: 100,
    maxRetries: 3,
    schematicUrl: 'https://files.catbox.moe/r7z2gh.nbt',
    schematicFile: 'house.nbt',
    safetyCheck: true,
    clearInventory: false, // Now handled more intelligently
    requestItems: true
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
    inventoryItems: {},
    isBuilding: false,
    isCollecting: false,
    missingItems: {}
};

// Helper functions
const log = (message) => {
    console.log(`[${new Date().toISOString()}] ${message}`);
    if (bot && bot.chat) bot.chat(message);
};

const getBlockName = (state) => state.Name.value.split(':')[1] || state.Name.value;

const scanInventory = () => {
    state.inventoryItems = {};
    bot.inventory.items().forEach(item => {
        state.inventoryItems[item.name] = (state.inventoryItems[item.name] || 0) + item.count;
    });
};

const goToPosition = async (position, distance = 1) => {
    const mcData = mcDataLoader(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalNear(position.x, position.y, position.z, distance));
    
    await new Promise((resolve) => {
        const checkArrival = setInterval(() => {
            if (bot.entity.position.distanceTo(position) <= distance + 0.5) {
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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const buffer = await res.buffer();
        fs.writeFileSync(CONFIG.schematicFile, buffer);
        
        const data = await nbt.parse(buffer);
        state.structure = data.parsed.value;

        // Calculate required items
        state.requiredItems = {};
        state.structure.blocks.value.value.forEach(block => {
            const blockState = state.structure.palette.value.value[block.state.value];
            const name = getBlockName(blockState);
            state.requiredItems[name] = (state.requiredItems[name] || 0) + 1;
        });

        log('Schematic loaded ✅');
    } catch (err) {
        log(`Failed to load schematic: ${err.message}`);
    }
};

const manageInventory = async () => {
    if (!state.chestPos) return false;
    
    try {
        await goToPosition(state.chestPos);
        const chestBlock = bot.blockAt(state.chestPos);
        if (!chestBlock) throw new Error('Chest not found');
        
        const chest = await bot.openChest(chestBlock);
        
        // Deposit non-building items
        for (const item of bot.inventory.items()) {
            if (!state.requiredItems[item.name]) {
                try {
                    await chest.deposit(item.type, null, item.count);
                    log(`Deposited ${item.count}x ${item.name} to chest`);
                } catch (err) {
                    log(`Failed to deposit ${item.name}: ${err.message}`);
                }
            }
        }
        
        // Withdraw needed items
        scanInventory();
        for (const [name, needed] of Object.entries(state.requiredItems)) {
            const have = state.inventoryItems[name] || 0;
            if (have < needed) {
                const items = chest.items().filter(i => i.name === name);
                if (items.length > 0) {
                    const toTake = Math.min(needed - have, items[0].count);
                    await chest.withdraw(items[0].type, null, toTake);
                    log(`Withdrew ${toTake}x ${name} from chest`);
                }
            }
        }
        
        await chest.close();
        return true;
    } catch (err) {
        log(`Chest error: ${err.message}`);
        return false;
    }
};

const collectNearbyItems = async () => {
    const items = Object.values(bot.entities).filter(e => e.type === 'item');
    for (const item of items) {
        if (state.requiredItems[item.name]) {
            await goToPosition(item.position, 2);
            await sleep(500); // Wait for item collection
        }
    }
};

const requestMissingItems = async () => {
    scanInventory();
    state.missingItems = {};
    
    for (const [name, needed] of Object.entries(state.requiredItems)) {
        const have = state.inventoryItems[name] || 0;
        if (have < needed) {
            state.missingItems[name] = needed - have;
        }
    }
    
    if (Object.keys(state.missingItems).length > 0) {
        log('Going to chest first...');
        await manageInventory();
        await collectNearbyItems();
        
        // Recheck after inventory management
        scanInventory();
        state.missingItems = {};
        
        for (const [name, needed] of Object.entries(state.requiredItems)) {
            const have = state.inventoryItems[name] || 0;
            if (have < needed) {
                state.missingItems[name] = needed - have;
            }
        }
        
        if (Object.keys(state.missingItems).length > 0) {
            log('Still missing items:');
            for (const [item, amount] of Object.entries(state.missingItems)) {
                log(`/give @s ${item} ${amount}`);
            }
            return false;
        }
    }
    return true;
};

const buildStructure = async () => {
    if (state.isBuilding) return;
    state.isBuilding = true;

    try {
        if (!state.buildPos || !state.structure) {
            throw new Error('Set build position and load schematic first');
        }

        // Manage inventory before building
        const ready = await requestMissingItems();
        if (!ready) {
            log('Cannot build without required items');
            return;
        }

        log('Starting building...');

        const { blocks, palette } = state.structure.blocks.value.value.reduce((acc, block) => {
            const blockState = state.structure.palette.value.value[block.state.value];
            const name = getBlockName(blockState);
            if (state.requiredItems[name]) {
                acc.blocks.push(block);
                acc.palette[block.state.value] = blockState;
            }
            return acc;
        }, { blocks: [], palette: {} });

        for (const block of blocks) {
            if (!state.isBuilding) break;

            const blockState = palette[block.state.value];
            const blockName = getBlockName(blockState);
            const position = new Vec3(
                block.pos.value[0] + state.buildPos.x,
                block.pos.value[1] + state.buildPos.y,
                block.pos.value[2] + state.buildPos.z
            );

            // Check inventory and collect items if needed
            const item = bot.inventory.items().find(i => i.name === blockName);
            if (!item) {
                log(`Out of ${blockName}, collecting more...`);
                await requestMissingItems();
                continue;
            }

            try {
                await bot.equip(item, 'hand');
                const reference = bot.blockAt(position.offset(0, -1, 0));
                if (!reference || reference.name === 'air') {
                    log(`No support below ${position}, adding support`);
                    await bot.equip(bot.inventory.items().find(i => i.name === 'dirt'), 'hand');
                    await bot.placeBlock(bot.blockAt(position.offset(0, -1, 0)), new Vec3(0, 1, 0));
                }
                await bot.placeBlock(bot.blockAt(position), new Vec3(0, 1, 0));
                await sleep(CONFIG.buildDelay);
            } catch (err) {
                log(`Building error: ${err.message}`);
            }
        }

        log('Build complete ✅');
    } catch (err) {
        log(`Build failed: ${err.message}`);
    } finally {
        state.isBuilding = false;
    }
};

// Event handlers
bot.once('spawn', async () => {
    log('Bot spawned!');
    await downloadSchematic();
});

const handleCommand = async (username, message) => {
    if (username === bot.username) return;

    const args = message.trim().split(' ');
    const cmd = args[0].toLowerCase();

    try {
        switch (cmd) {
            case '!setchest':
                if (args.length === 4) {
                    state.chestPos = new Vec3(+args[1], +args[2], +args[3]);
                    log(`Chest set at ${state.chestPos}`);
                }
                break;

            case '!come':
                if (args.length === 4) {
                    state.buildPos = new Vec3(+args[1], +args[2], +args[3]);
                    await goToPosition(state.buildPos);
                }
                break;

            case '!build':
                await buildStructure();
                break;

            case '!materials':
                await requestMissingItems();
                break;

            case '!collect':
                await collectNearbyItems();
                break;

            case '!stop':
                state.isBuilding = false;
                log('Stopped current action');
                break;

            case '!help':
                log('Commands: !setchest x y z, !come x y z, !build, !materials, !collect, !stop');
                break;
        }
    } catch (err) {
        log(`Error: ${err.message}`);
    }
};

bot.on('chat', (username, message) => {
    handleCommand(username, message).catch(err => {
        log(`Command error: ${err.message}`);
    });
});

bot.on('error', err => log(`Error: ${err.message}`));
bot.on('kicked', reason => log(`Kicked: ${reason}`));
bot.on('end', reason => log(`Disconnected: ${reason}`));

// Collect nearby items periodically
setInterval(async () => {
    if (!state.isBuilding && !state.isCollecting) {
        state.isCollecting = true;
        try {
            await collectNearbyItems();
        } catch (err) {
            log(`Collection error: ${err.message}`);
        } finally {
            state.isCollecting = false;
        }
    }
}, 30000);    } else {
        log('All required items available!');
    }
};

const buildStructure = async () => {
    if (state.isBuilding) {
        log('Already building!');
        return;
    }

    state.isBuilding = true;

    try {
        if (!state.buildPos || !state.structure) {
            throw new Error('Set a build position and load schematic first');
        }

        scanInventory();

        if (CONFIG.clearInventory) {
            for (const item of bot.inventory.items()) {
                if (!state.requiredItems[item.name]) {
                    try {
                        await bot.tossStack(item);
                    } catch (err) {
                        log(`Failed to drop ${item.name}: ${err.message}`);
                    }
                }
            }
        }

        // Check for missing items before building
        requestMissingItems();
        if (Object.keys(state.missingItems).length > 0) {
            log('Please provide missing items first!');
            return;
        }

        log('Starting building process 🧱');

        const blocks = state.structure.blocks.value.value;
        const palette = state.structure.palette.value.value;

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const blockState = palette[block.state.value];
            const blockName = getBlockName(blockState);
            const position = new Vec3(
                block.pos.value[0] + state.buildPos.x,
                block.pos.value[1] + state.buildPos.y,
                block.pos.value[2] + state.buildPos.z
            );

            const item = bot.inventory.items().find(it => it.name === blockName);
            if (!item) {
                log(`Out of ${blockName}, requesting more...`);
                log(`/give @s ${blockName} ${state.requiredItems[blockName]}`);
                continue;
            }

            try {
                await bot.equip(item, 'hand');
                const reference = bot.blockAt(position.offset(0, -1, 0));
                if (!reference || reference.name === 'air') {
                    log(`No support below ${position}, skipping block`);
                    continue;
                }
                await bot.placeBlock(reference, new Vec3(0, 1, 0));
                await sleep(CONFIG.buildDelay);
            } catch (err) {
                log(`Failed to place ${blockName} at ${position}: ${err.message}`);
            }
        }

        log('Build complete ✅');
    } catch (err) {
        log(`Build failed: ${err.message}`);
    } finally {
        state.isBuilding = false;
    }
};

// Event handlers
bot.once('spawn', async () => {
    log('Bot spawned!');
    await downloadSchematic();
});

const handleChatCommand = async (username, message) => {
    if (username === bot.username) return;

    const args = message.trim().split(' ');
    const command = args[0].toLowerCase();

    try {
        switch (command) {
            case '!setchest':
                if (args.length === 4) {
                    state.chestPos = new Vec3(+args[1], +args[2], +args[3]);
                    log(`Chest set at ${state.chestPos}`);
                }
                break;

            case '!come':
                if (args.length === 4) {
                    state.buildPos = new Vec3(+args[1], +args[2], +args[3]);
                    await goToPosition(state.buildPos);
                }
                break;

            case '!build':
                await buildStructure();
                break;

            case '!materials':
                requestMissingItems();
                break;

            case '!stop':
                state.isBuilding = false;
                log('Stopped building');
                break;

            case '!help':
                log('Available commands:');
                log('!setchest x y z - Set chest location');
                log('!come x y z - Move to build location');
                log('!build - Start building');
                log('!materials - Show missing materials');
                log('!stop - Cancel building');
                break;
        }
    } catch (err) {
        log(`Error: ${err.message}`);
    }
};

bot.on('chat', (username, message) => {
    handleChatCommand(username, message).catch(err => {
        log(`Command processing error: ${err.message}`);
    });
});

bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Kicked: ${reason}`));
bot.on('end', reason => log(`Disconnected: ${reason}`));

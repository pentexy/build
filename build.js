const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock } = goals;
const { Vec3 } = require('vec3');
const nbt = require('prismarine-nbt');
const fs = require('fs');
const mcDataLoader = require('minecraft-data');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// Configuration
const CONFIG = {
    host: 'unholy-engraved.ap.e4mc.link',
    port: 25565,
    username: 'BuilderBot',
    buildDelay: 100,
    schematicUrl: 'https://files.catbox.moe/r7z2gh.nbt',
    layers: {
        collectThreshold: 32, // Items to collect before building layer
        maxLayerItems: 64     // Max items to carry per layer
    }
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
    currentLayer: 0,
    isBuilding: false,
    isCollecting: false
};

// Helper functions
const log = (message) => {
    console.log(`[BuilderBot] ${message}`);
    bot.chat(message);
};

const getBlockName = (state) => state.Name.value.split(':')[1] || state.Name.value;

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
        const buffer = await res.buffer();
        fs.writeFileSync('schematic.nbt', buffer);
        
        const data = await nbt.parse(buffer);
        state.structure = data.parsed.value;
        log('Schematic loaded ✅');
    } catch (err) {
        log(`Schematic error: ${err.message}`);
    }
};

const organizeInventory = async () => {
    if (!state.chestPos) return;
    
    await goToPosition(state.chestPos);
    const chest = await bot.openChest(bot.blockAt(state.chestPos));
    
    // Deposit non-essential items
    for (const item of bot.inventory.items()) {
        if (!isNeededForCurrentLayer(item.name)) {
            await chest.deposit(item.type, null, item.count);
        }
    }
    await chest.close();
};

const isNeededForCurrentLayer = (itemName) => {
    if (!state.structure) return false;
    
    const blocks = state.structure.blocks.value.value;
    const palette = state.structure.palette.value.value;
    
    return blocks.some(block => {
        const y = block.pos.value[1];
        if (Math.floor(y) !== state.currentLayer) return false;
        
        const blockState = palette[block.state.value];
        return getBlockName(blockState) === itemName;
    });
};

const collectLayerItems = async () => {
    state.isCollecting = true;
    
    // 1. Get items from chest first
    if (state.chestPos) {
        await goToPosition(state.chestPos);
        const chest = await bot.openChest(bot.blockAt(state.chestPos));
        
        for (const item of chest.items()) {
            if (isNeededForCurrentLayer(item.name)) {
                const toWithdraw = Math.min(item.count, CONFIG.layers.maxLayerItems);
                await chest.withdraw(item.type, null, toWithdraw);
            }
        }
        await chest.close();
    }
    
    // 2. Collect nearby floating items
    const items = Object.values(bot.entities).filter(e => 
        e.type === 'item' && isNeededForCurrentLayer(e.name)
    );
    
    for (const item of items) {
        await goToPosition(item.position, 2);
        await sleep(500); // Wait for collection
    }
    
    state.isCollecting = false;
};

const buildCurrentLayer = async () => {
    if (!state.structure || !state.buildPos) return;
    
    state.isBuilding = true;
    const blocks = state.structure.blocks.value.value;
    const palette = state.structure.palette.value.value;
    
    // Filter blocks for current layer
    const layerBlocks = blocks.filter(block => 
        Math.floor(block.pos.value[1]) === state.currentLayer
    );
    
    for (const block of layerBlocks) {
        if (!state.isBuilding) break;
        
        const blockState = palette[block.state.value];
        const blockName = getBlockName(blockState);
        const position = new Vec3(
            block.pos.value[0] + state.buildPos.x,
            block.pos.value[1] + state.buildPos.y,
            block.pos.value[2] + state.buildPos.z
        );
        
        try {
            const item = bot.inventory.items().find(i => i.name === blockName);
            if (!item) {
                log(`Missing ${blockName}, collecting more...`);
                await collectLayerItems();
                continue;
            }
            
            await bot.equip(item, 'hand');
            await bot.placeBlock(bot.blockAt(position), new Vec3(0, 1, 0));
            await sleep(CONFIG.buildDelay);
        } catch (err) {
            log(`Building error: ${err.message}`);
        }
    }
    
    if (state.isBuilding) {
        log(`Layer ${state.currentLayer} complete!`);
        state.currentLayer++;
    }
    state.isBuilding = false;
};

// Event handlers
bot.once('spawn', async () => {
    log('Bot ready!');
    await downloadSchematic();
});

bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    
    const args = message.trim().split(' ');
    const cmd = args[0].toLowerCase();
    
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
                }
                break;
                
            case '!build':
                if (!state.isBuilding) {
                    state.currentLayer = 0;
                    await buildCurrentLayer();
                }
                break;
                
            case '!nextlayer':
                if (!state.isBuilding) {
                    await buildCurrentLayer();
                }
                break;
                
            case '!stop':
                state.isBuilding = false;
                log('Stopped building');
                break;
        }
    } catch (err) {
        log(`Error: ${err.message}`);
    }
});

// Auto-collect nearby items periodically
setInterval(async () => {
    if (!state.isBuilding && !state.isCollecting) {
        await collectLayerItems();
    }
}, 15000);        return false;
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
}, 30000);

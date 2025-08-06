const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock, GoalNear } = goals;
const fs = require('fs');
const fetch = require('node-fetch');
const nbt = require('prismarine-nbt');
const { Vec3 } = require('vec3');
const mcDataLoader = require('minecraft-data');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// Configuration
const CONFIG = {
    host: 'unholy-engraved.ap.e4mc.link',
    port: 25565,
    username: 'BuilderBot',
    buildDelay: 100, // ms between block placements
    maxRetries: 3,
    schematicUrl: 'https://files.catbox.moe/r7z2gh.nbt',
    schematicFile: 'house.nbt',
    safetyCheck: true, // prevent building in unsafe positions
    clearInventory: true // drop non-required items
};

// Create bot instance
const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username
});

// Load plugins
bot.loadPlugin(pathfinder);

// State management
const state = {
    chestPos: null,
    buildPos: null,
    structure: null,
    requiredItems: {},
    inventoryItems: {},
    isBuilding: false,
    currentTask: null
};

// Helper functions
const log = (message) => {
    console.log(`[${new Date().toISOString()}] ${message}`);
    bot.chat(message);
};

const getBlockName = (state) => {
    return state.Name.value.split(':')[1] || state.Name.value;
};

const scanInventory = () => {
    state.inventoryItems = {};
    bot.inventory.items().forEach(item => {
        state.inventoryItems[item.name] = (state.inventoryItems[item.name] || 0) + item.count;
    });
};

const hasEnoughItems = () => {
    for (const [name, count] of Object.entries(state.requiredItems)) {
        if ((state.inventoryItems[name] || 0) < count) {
            return false;
        }
    }
    return true;
};

const findItemInInventory = (name) => {
    return bot.inventory.items().find(item => item.name === name);
};

const goToPosition = async (position) => {
    try {
        const mcData = mcDataLoader(bot.version);
        const movements = new Movements(bot, mcData);
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new GoalNear(position.x, position.y, position.z, 1));
        
        // Wait until arrived or timeout after 30 seconds
        await new Promise((resolve, reject) => {
            const checkArrival = setInterval(() => {
                const distance = bot.entity.position.distanceTo(position);
                if (distance < 2) {
                    clearInterval(checkArrival);
                    resolve();
                }
            }, 1000);
            
            setTimeout(() => {
                clearInterval(checkArrival);
                reject(new Error('Timeout while trying to reach position'));
            }, 30000);
        });
    } catch (err) {
        log(`Failed to reach position: ${err.message}`);
        throw err;
    }
};

const downloadSchematic = async () => {
    try {
        log('Downloading schematic...');
        const res = await fetch(CONFIG.schematicUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const buffer = await res.buffer();
        fs.writeFileSync(CONFIG.schematicFile, buffer);
        
        const data = nbt.parseUncompressed(buffer);
        state.structure = data.value;
        log('Schematic loaded successfully ✅');
        
        // Parse required blocks
        state.requiredItems = {};
        state.structure.blocks.value.forEach(block => {
            const state = state.structure.palette.value[block.state.value];
            const name = getBlockName(state);
            state.requiredItems[name] = (state.requiredItems[name] || 0) + 1;
        });
        
        return true;
    } catch (err) {
        log(`Failed to load schematic: ${err.message}`);
        return false;
    }
};

const checkBuildArea = () => {
    if (!CONFIG.safetyCheck) return true;
    
    const size = state.structure.size.value.value;
    const start = state.buildPos;
    const end = new Vec3(
        start.x + size[0],
        start.y + size[1],
        start.z + size[2]
    );
    
    // Simple check for non-air blocks in build area
    for (let x = start.x; x <= end.x; x++) {
        for (let y = start.y; y <= end.y; y++) {
            for (let z = start.z; z <= end.z; z++) {
                const block = bot.blockAt(new Vec3(x, y, z));
                if (block && block.type !== 0) { // 0 is air
                    log(`Build area not clear at ${x},${y},${z}`);
                    return false;
                }
            }
        }
    }
    return true;
};

const getMissingItems = () => {
    const missing = {};
    scanInventory();
    
    for (const [name, count] of Object.entries(state.requiredItems)) {
        const have = state.inventoryItems[name] || 0;
        if (have < count) {
            missing[name] = count - have;
        }
    }
    
    return missing;
};

const fetchFromChest = async () => {
    if (!state.chestPos) {
        log('No chest position set ❌');
        return false;
    }
    
    try {
        log('Going to chest to fetch missing items...');
        await goToPosition(state.chestPos);
        
        const chest = bot.blockAt(state.chestPos);
        const chestWindow = await bot.openChest(chest);
        
        const missing = getMissingItems();
        let fetchedAny = false;
        
        for (const [name, count] of Object.entries(missing)) {
            const items = chestWindow.containerItems().filter(item => item.name === name);
            if (items.length > 0) {
                const toWithdraw = Math.min(count, items[0].count);
                try {
                    await chestWindow.withdraw(items[0].type, null, toWithdraw);
                    log(`Withdrawn ${toWithdraw} ${name} from chest`);
                    fetchedAny = true;
                } catch (err) {
                    log(`Failed to withdraw ${name}: ${err.message}`);
                }
            }
        }
        
        await chestWindow.close();
        return fetchedAny;
    } catch (err) {
        log(`Chest operation failed: ${err.message}`);
        return false;
    }
};

const buildStructure = async () => {
    if (state.isBuilding) {
        log('Already building!');
        return;
    }
    
    state.isBuilding = true;
    
    try {
        // Pre-build checks
        if (!state.buildPos || !state.structure) {
            throw new Error('Set a build position and load schematic first');
        }
        
        if (!checkBuildArea()) {
            throw new Error('Build area is not clear');
        }
        
        // Inventory management
        scanInventory();
        
        if (CONFIG.clearInventory) {
            // Drop non-required items
            bot.inventory.items().forEach(item => {
                if (!state.requiredItems[item.name]) {
                    bot.tossStack(item).catch(err => {
                        log(`Failed to drop ${item.name}: ${err.message}`);
                    });
                }
            });
        }
        
        // Check if we have all required items
        const missing = getMissingItems();
        if (Object.keys(missing).length > 0) {
            log(`Missing items: ${JSON.stringify(missing)}`);
            
            // Try to get from chest
            if (state.chestPos) {
                const success = await fetchFromChest();
                if (!success) {
                    throw new Error('Missing required items and failed to fetch from chest');
                }
            } else {
                throw new Error('Missing required items and no chest set');
            }
        }
        
        log('Starting building process 🧱');
        
        const blocks = state.structure.blocks.value;
        const size = state.structure.size.value.value;
        
        // Build in layers from bottom to top for stability
        const layers = {};
        blocks.forEach(block => {
            const y = block.pos.value[1];
            if (!layers[y]) layers[y] = [];
            layers[y].push(block);
        });
        
        const sortedLayers = Object.keys(layers).sort((a, b) => a - b);
        
        for (const layer of sortedLayers) {
            log(`Building layer ${layer}...`);
            
            for (const block of layers[layer]) {
                const stateInfo = state.structure.palette.value[block.state.value];
                const blockName = getBlockName(stateInfo);
                const position = new Vec3(
                    block.pos.value[0] + state.buildPos.x,
                    block.pos.value[1] + state.buildPos.y,
                    block.pos.value[2] + state.buildPos.z
                );
                
                // Check if we still have the block
                const item = findItemInInventory(blockName);
                if (!item) {
                    log(`Ran out of ${blockName}, fetching more...`);
                    const success = await fetchFromChest();
                    if (!success) {
                        throw new Error(`Failed to get more ${blockName}`);
                    }
                }
                
                // Equip and place
                try {
                    await bot.equip(findItemInInventory(blockName), 'hand');
                    await bot.placeBlock(bot.blockAt(position), new Vec3(0, 1, 0));
                    await sleep(CONFIG.buildDelay);
                } catch (err) {
                    log(`Failed to place ${blockName} at ${position}: ${err.message}`);
                    // Try to recover by getting more blocks
                    const success = await fetchFromChest();
                    if (!success) {
                        throw new Error(`Failed to recover from placement error: ${err.message}`);
                    }
                }
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

bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    
    const args = message.split(' ');
    const command = args[0].toLowerCase();
    
    try {
        switch (command) {
            case '!setchest':
                if (args.length === 4) {
                    state.chestPos = new Vec3(+args[1], +args[2], +args[3]);
                    log(`Chest set at ${state.chestPos}`);
                } else {
                    log('Usage: !setchest x y z');
                }
                break;
                
            case '!come':
                if (args.length === 4) {
                    state.buildPos = new Vec3(+args[1], +args[2], +args[3]);
                    log(`Coming to ${state.buildPos}...`);
                    await goToPosition(state.buildPos);
                } else {
                    log('Usage: !come x y z');
                }
                break;
                
            case '!build':
                await buildStructure();
                break;
                
            case '!materials':
                if (!state.structure) {
                    log('No schematic loaded');
                    return;
                }
                
                const missing = getMissingItems();
                if (Object.keys(missing).length === 0) {
                    log('All required materials are available');
                } else {
                    log(`Missing materials: ${JSON.stringify(missing)}`);
                }
                break;
                
            case '!stop':
                state.isBuilding = false;
                log('Stopping current operation');
                break;
                
            case '!status':
                log(`Builder Bot Status:
- Chest Position: ${state.chestPos || 'Not set'}
- Build Position: ${state.buildPos || 'Not set'}
- Schematic: ${state.structure ? 'Loaded' : 'Not loaded'}
- Building: ${state.isBuilding ? 'Yes' : 'No'}
- Inventory: ${JSON.stringify(state.inventoryItems)}`);
                break;
        }
    } catch (err) {
        log(`Command error: ${err.message}`);
    }
});

// Error handling
bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Kicked: ${reason}`));
bot.on('end', reason => log(`Disconnected: ${reason}`));

// Periodic inventory scan
setInterval(scanInventory, 5000);

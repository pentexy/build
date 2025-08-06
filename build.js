const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock, GoalNear } = goals;
const fs = require('fs');
const nbt = require('prismarine-nbt');
const { Vec3 } = require('vec3');
const mcDataLoader = require('minecraft-data');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// For Node.js <18, use node-fetch (install with: npm install node-fetch@2)
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
    clearInventory: true
};

const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username
});

bot.loadPlugin(pathfinder);

// State management
const state = {
    chestPos: null,
    buildPos: null,
    structure: null,
    requiredItems: {},
    inventoryItems: {},
    isBuilding: false
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

const goToPosition = async (position) => {
    try {
        const mcData = mcDataLoader(bot.version);
        const movements = new Movements(bot, mcData);
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new GoalNear(position.x, position.y, position.z, 1));
        
        await new Promise((resolve, reject) => {
            const checkArrival = setInterval(() => {
                if (bot.entity.position.distanceTo(position) < 2) {
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
        
        const data = await nbt.parse(buffer);
        state.structure = data;
        log('Schematic loaded successfully ✅');
        
        // Parse required blocks
        state.requiredItems = {};
        state.structure.blocks.value.forEach(block => {
            const blockState = state.structure.palette.value[block.state.value];
            const name = getBlockName(blockState);
            state.requiredItems[name] = (state.requiredItems[name] || 0) + 1;
        });
        
        return true;
    } catch (err) {
        log(`Failed to load schematic: ${err.message}`);
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
        if (!state.buildPos || !state.structure) {
            throw new Error('Set a build position and load schematic first');
        }

        scanInventory();
        
        if (CONFIG.clearInventory) {
            bot.inventory.items().forEach(item => {
                if (!state.requiredItems[item.name]) {
                    bot.tossStack(item).catch(err => {
                        log(`Failed to drop ${item.name}: ${err.message}`);
                    });
                }
            });
        }

        log('Starting building process 🧱');
        
        const blocks = state.structure.blocks.value;
        
        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const blockState = state.structure.palette.value[block.state.value];
            const blockName = getBlockName(blockState);
            const position = new Vec3(
                block.pos.value[0] + state.buildPos.x,
                block.pos.value[1] + state.buildPos.y,
                block.pos.value[2] + state.buildPos.z
            );
            
            const item = bot.inventory.items().find(it => it.name === blockName);
            
            if (!item) {
                log(`Out of ${blockName}, skipping...`);
                continue;
            }
            
            try {
                await bot.equip(item, 'hand');
                await bot.placeBlock(bot.blockAt(position), new Vec3(0, 1, 0));
                await sleep(CONFIG.buildDelay);
            } catch (err) {
                log(`Failed to place ${blockName}: ${err.message}`);
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
                log(`Required materials: ${JSON.stringify(state.requiredItems)}`);
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

bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Kicked: ${reason}`));
bot.on('end', reason => log(`Disconnected: ${reason}`));        
        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const blockState = state.structure.palette.value[block.state.value];
            const blockName = getBlockName(blockState);
            const position = new Vec3(
                block.pos.value[0] + state.buildPos.x,
                block.pos.value[1] + state.buildPos.y,
                block.pos.value[2] + state.buildPos.z
            );
            
            const item = bot.inventory.items().find(it => it.name === blockName);
            
            if (!item) {
                log(`Out of ${blockName}, skipping...`);
                continue;
            }
            
            try {
                await bot.equip(item, 'hand');
                await bot.placeBlock(bot.blockAt(position), new Vec3(0, 1, 0));
                await sleep(CONFIG.buildDelay);
            } catch (err) {
                log(`Failed to place ${blockName}: ${err.message}`);
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
                log(`Required materials: ${JSON.stringify(state.requiredItems)}`);
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

bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Kicked: ${reason}`));
bot.on('end', reason => log(`Disconnected: ${reason}`));

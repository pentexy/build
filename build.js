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
    host: '18.143.129.103', // Your server IP
    port: 25565,
    username: 'BuilderBot',
    buildDelay: 200,
    maxLayersPerTrip: 3,
    scaffoldBlock: 'dirt',
    schematicUrl: 'https://files.catbox.moe/r7z2gh.nbt'
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
    isCollecting: false,
    layers: {}
};

// Helper functions
const log = (message) => {
    console.log(`[BuilderBot] ${message}`);
    if (bot && bot.chat) bot.chat(message);
};

const getBlockName = (state) => {
    if (!state || !state.Name || !state.Name.value) return '';
    return state.Name.value.split(':')[1] || state.Name.value;
};

const goToPosition = async (position, distance = 1) => {
    try {
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
    } catch (err) {
        log(`Movement error: ${err.message}`);
    }
};

const facePosition = async (position) => {
    try {
        const delta = position.minus(bot.entity.position);
        bot.lookAt(delta, true);
        await sleep(200);
    } catch (err) {
        log(`Facing error: ${err.message}`);
    }
};

const downloadSchematic = async () => {
    try {
        log('Downloading schematic...');
        const res = await fetch(CONFIG.schematicUrl);
        const buffer = await res.buffer();
        fs.writeFileSync('schematic.nbt', buffer);
        
        const data = await nbt.parse(buffer);
        state.structure = data.parsed.value;
        
        // Organize blocks by layer
        state.layers = {};
        state.structure.blocks.value.value.forEach(block => {
            const y = Math.floor(block.pos.value[1]);
            if (!state.layers[y]) state.layers[y] = [];
            state.layers[y].push(block);
        });
        
        log(`Loaded schematic with ${Object.keys(state.layers).length} layers`);
    } catch (err) {
        log(`Schematic error: ${err.message}`);
    }
};

const getItemsForLayers = (startLayer, count) => {
    const items = {};
    for (let i = 0; i < count; i++) {
        const layer = startLayer + i;
        if (!state.layers[layer]) continue;
        
        state.layers[layer].forEach(block => {
            const blockState = state.structure.palette.value.value[block.state.value];
            const name = getBlockName(blockState);
            if (name) items[name] = (items[name] || 0) + 1;
        });
    }
    return items;
};

const manageChestInventory = async () => {
    if (!state.chestPos) {
        log('No chest set! Use !setchest first');
        return false;
    }

    try {
        await goToPosition(state.chestPos);
        await facePosition(state.chestPos);
        
        const chestBlock = bot.blockAt(state.chestPos);
        if (!chestBlock || !chestBlock.name.includes('chest')) {
            log('No chest found at location');
            return false;
        }

        const chest = await bot.openChest(chestBlock);
        
        // 1. Deposit all non-essential items
        for (const item of bot.inventory.items()) {
            if (item.name !== CONFIG.scaffoldBlock) {
                try {
                    await chest.deposit(item.type, null, item.count);
                } catch (err) {
                    log(`Deposit error: ${err.message}`);
                }
            }
        }
        
        // 2. Withdraw needed items for next layers
        const layersToBuild = Math.min(CONFIG.maxLayersPerTrip, Object.keys(state.layers).length - state.currentLayer);
        const neededItems = getItemsForLayers(state.currentLayer, layersToBuild);
        
        for (const [name, count] of Object.entries(neededItems)) {
            const items = chest.items().filter(i => i.name === name);
            if (items.length > 0) {
                try {
                    await chest.withdraw(items[0].type, null, Math.min(count, items[0].count));
                } catch (err) {
                    log(`Withdraw error: ${err.message}`);
                }
            }
        }
        
        // 3. Ensure we have scaffold blocks
        const scaffoldItems = chest.items().filter(i => i.name === CONFIG.scaffoldBlock);
        if (scaffoldItems.length > 0) {
            try {
                await chest.withdraw(scaffoldItems[0].type, null, 64);
            } catch (err) {
                log(`Scaffold withdraw error: ${err.message}`);
            }
        }
        
        await chest.close();
        return true;
    } catch (err) {
        log(`Chest management error: ${err.message}`);
        return false;
    }
};

const buildScaffold = async (position) => {
    try {
        if (!bot.inventory.items().some(i => i.name === CONFIG.scaffoldBlock)) {
            log(`No ${CONFIG.scaffoldBlock} for scaffolding`);
            return false;
        }

        const scaffoldPos = position.floored();
        while (bot.entity.position.y + 1 < scaffoldPos.y) {
            const blockBelow = bot.blockAt(scaffoldPos.offset(0, -1, 0));
            if (!blockBelow || blockBelow.name === 'air') {
                const scaffoldItem = bot.inventory.items().find(i => i.name === CONFIG.scaffoldBlock);
                if (scaffoldItem) {
                    await bot.equip(scaffoldItem, 'hand');
                    const targetBlock = blockBelow || bot.blockAt(scaffoldPos.offset(0, -2, 0));
                    if (targetBlock) {
                        await bot.placeBlock(targetBlock, new Vec3(0, 1, 0));
                    }
                }
                await sleep(200);
            }
            await bot.setControlState('jump', true);
            await sleep(200);
            await bot.setControlState('jump', false);
            await sleep(200);
        }
        return true;
    } catch (err) {
        log(`Scaffolding error: ${err.message}`);
        return false;
    }
};

const buildLayers = async (startLayer, count) => {
    if (state.isBuilding) return;
    state.isBuilding = true;
    
    try {
        for (let i = 0; i < count; i++) {
            const layer = startLayer + i;
            if (!state.layers[layer] || !state.isBuilding) break;
            
            log(`Building layer ${layer}`);
            
            for (const block of state.layers[layer]) {
                if (!state.isBuilding) break;
                
                const blockState = state.structure.palette.value.value[block.state.value];
                const blockName = getBlockName(blockState);
                const position = new Vec3(
                    block.pos.value[0] + state.buildPos.x,
                    block.pos.value[1] + state.buildPos.y,
                    block.pos.value[2] + state.buildPos.z
                );
                
                // Build scaffold if needed
                if (position.y > bot.entity.position.y + 2) {
                    await buildScaffold(position);
                }
                
                try {
                    const item = bot.inventory.items().find(i => i.name === blockName);
                    if (!item) {
                        log(`Missing ${blockName}, will get more later`);
                        continue;
                    }
                    
                    await bot.equip(item, 'hand');
                    const targetBlock = bot.blockAt(position);
                    if (targetBlock) {
                        await bot.placeBlock(targetBlock, new Vec3(0, 1, 0));
                    }
                    await sleep(CONFIG.buildDelay);
                } catch (err) {
                    log(`Building error: ${err.message}`);
                }
            }
            
            if (state.isBuilding) {
                log(`Completed layer ${layer}`);
                state.currentLayer++;
            }
        }
    } catch (err) {
        log(`Build process error: ${err.message}`);
    } finally {
        state.isBuilding = false;
    }
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
                if (!state.isBuilding) {
                    if (!state.buildPos) {
                        log('Set build position first with !come');
                        return;
                    }
                    
                    // 1. Go to chest and manage inventory
                    const success = await manageChestInventory();
                    if (!success) return;
                    
                    // 2. Go to build site and build layers
                    await goToPosition(state.buildPos);
                    await buildLayers(state.currentLayer, CONFIG.maxLayersPerTrip);
                    
                    // 3. Return to chest if more layers remain
                    if (state.currentLayer < Object.keys(state.layers).length) {
                        await manageChestInventory();
                    }
                }
                break;
                
            case '!stop':
                state.isBuilding = false;
                log('Stopped building process');
                break;
                
            case '!status':
                log(`Current layer: ${state.currentLayer}/${Object.keys(state.layers).length}`);
                log(`Build position: ${state.buildPos ? state.buildPos : 'Not set'}`);
                log(`Chest position: ${state.chestPos ? state.chestPos : 'Not set'}`);
                break;
        }
    } catch (err) {
        log(`Command error: ${err.message}`);
    }
});

// For Node.js <18
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Error handling
bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Kicked: ${reason}`));
bot.on('end', reason => log(`Disconnected: ${reason}`));

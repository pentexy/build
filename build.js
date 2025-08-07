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
    host: '54.151.198.24',
    port: 25565,
    username: 'BuilderBot',
    buildDelay: 200,
    scaffoldBlock: 'dirt',
    schematicUrl: 'https://files.catbox.moe/q1kime.nbt'
};

const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username
});

bot.loadPlugin(pathfinder);

const state = {
    buildPos: null,
    structure: null,
    requiredItems: {},
    missingItems: {},
    receivedItems: {},
    isBuilding: false
};

// Helper functions
const log = (message) => {
    console.log(`[BuilderBot] ${message}`);
    bot.chat(message);
};

const getBlockName = (state) => {
    if (!state || !state.Name || !state.Name.value) return '';
    return state.Name.value.split(':')[1] || state.Name.value;
};

const scanInventory = () => {
    const items = {};
    bot.inventory.items().forEach(item => {
        items[item.name] = (items[item.name] || 0) + item.count;
    });
    return items;
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
        }, 30000); 

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
        log('Loading schematic...');
        const res = await fetch(CONFIG.schematicUrl);
        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync('schematic.nbt', buffer);
        
        const data = await nbt.parse(buffer);
        state.structure = data.parsed.value;

        state.requiredItems = {};
        state.structure.blocks.value.value.forEach(block => {
            const blockState = state.structure.palette.value.value[block.state.value];
            const name = getBlockName(blockState);
            if (name && name !== 'air') {
                state.requiredItems[name] = (state.requiredItems[name] || 0) + 1;
            }
        });

        updateMissingItems();
        log('Schematic loaded');
    } catch (err) {
        log(`Schematic error: ${err.message}`);
    }
};

const updateMissingItems = () => {
    const inventory = scanInventory();
    state.missingItems = {};
    state.receivedItems = {};

    for (const [name, needed] of Object.entries(state.requiredItems)) {
        const have = inventory[name] || 0;
        if (have < needed) {
            state.missingItems[name] = needed - have;
        } else if (have > 0) {
            state.receivedItems[name] = have;
        }
    }
};

const buildScaffold = async (targetY) => {
    const scaffoldItem = bot.inventory.items().find(i => i.name === CONFIG.scaffoldBlock);
    if (!scaffoldItem) return false;

    await bot.equip(scaffoldItem, 'hand');
    
    while (bot.entity.position.y + 1 < targetY) {
        const currentPos = bot.entity.position.floored();
        const belowPos = new Vec3(currentPos.x, currentPos.y - 1, currentPos.z);
        const belowBlock = bot.blockAt(belowPos);
        
        if (!belowBlock || belowBlock.name === 'air') {
            await bot.placeBlock(belowBlock || bot.blockAt(new Vec3(currentPos.x, currentPos.y - 2, currentPos.z)), new Vec3(0, 1, 0));
            await sleep(200);
        }
        
        await bot.setControlState('jump', true);
        await sleep(300);
        await bot.setControlState('jump', false);
        await sleep(300);
    }
    
    return true;
};

const buildStructure = async () => {
    if (state.isBuilding || !state.buildPos || !state.structure) {
        if (!state.buildPos) {
            log('Error: Build position is not set. Use !setbuildpos <x> <y> <z>.');
        }
        return;
    }
    state.isBuilding = true;

    try {
        log('Starting to build...');
        const blocks = state.structure.blocks.value.value;
        const palette = state.structure.palette.value.value;
        const sortedBlocks = blocks.sort((a, b) => a.pos.value[1] - b.pos.value[1]);

        for (const block of sortedBlocks) {
            if (!state.isBuilding) break;

            const blockState = palette[block.state.value];
            const blockName = getBlockName(blockState);
            
            if (blockName === 'air') continue;

            const position = new Vec3(
                block.pos.value[0] + state.buildPos.x,
                block.pos.value[1] + state.buildPos.y,
                block.pos.value[2] + state.buildPos.z
            );
            
            const existingBlock = bot.blockAt(position);
            if (existingBlock && existingBlock.name === blockName) {
                continue; 
            }
            log(`Attempting to place ${blockName} at ${position.x},${position.y},${position.z}`);

            const item = bot.inventory.findInventoryItem(bot.mcData.blocksByName[blockName]?.id);
            if (!item) {
                log(`Skipping ${blockName} as no matching item was found in inventory.`);
                continue;
            }

            try {
                await goToPosition(position.offset(0.5, 0, 0.5));
                
                await bot.equip(item, 'hand');
                const blockToPlaceOn = bot.blockAt(position.offset(0, -1, 0));
                
                if (blockToPlaceOn && blockToPlaceOn.name !== 'air') {
                    await bot.placeBlock(blockToPlaceOn, new Vec3(0, 1, 0));
                    log(`Successfully placed ${blockName}`);
                    await sleep(CONFIG.buildDelay);
                } else {
                    log(`Failed to place ${blockName}: no solid block below.`);
                }
            } catch (err) {
                log(`Building error at ${position.x},${position.y},${position.z}: ${err.message}`);
            }
        }
        log('!built');
    } catch (err) {
        log(`Build failed: ${err.message}`);
    } finally {
        state.isBuilding = false;
        updateMissingItems();
    }
};

// Event handlers
bot.once('spawn', async () => {
    bot.mcData = mcDataLoader(bot.version);
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
                case '!setbuildpos':
                    if (args.length === 4) {
                        state.buildPos = new Vec3(parseFloat(args[1]), parseFloat(args[2]), parseFloat(args[3]));
                        log(`Build location set to ${state.buildPos.x}, ${state.buildPos.y}, ${state.buildPos.z}`);
                    } else {
                        log('Usage: !setbuildpos <x> <y> <z>');
                    }
                    break;
                case '!come':
                    if (state.buildPos) {
                        log('Going to build location');
                        await goToPosition(state.buildPos);
                        log('Arrived at build location');
                        updateMissingItems();
                    } else {
                        log('Please set the build position first using !setbuildpos');
                    }
                    break;
                    
                case '!hru':
                    updateMissingItems();
                    if (Object.keys(state.receivedItems).length > 0) {
                        log('Received items:');
                        Object.entries(state.receivedItems).forEach(([name, count]) => {
                            log(`${count}x ${name}`);
                        });
                    }
                    if (Object.keys(state.missingItems).length > 0) {
                        log('Still missing:');
                        Object.entries(state.missingItems).forEach(([name, count]) => {
                            log(`${count}x ${name}`);
                        });
                    } else {
                        log('All materials received!');
                    }
                    break;
                    
                case '!build':
                    updateMissingItems();
                    if (Object.keys(state.missingItems).length === 0) {
                        await buildStructure();
                    } else {
                        log('Still missing materials. Use !hru to check');
                    }
                    break;
                    
                case '!stop':
                    state.isBuilding = false;
                    log('Stopped building');
                    break;
            }
        } catch (err) {
            log(`Command error: ${err.message}`);
        }
    })();
});

// Track received items
bot.on('playerCollect', (collector, item) => {
    if (collector !== bot.entity) return;
    
    const name = item.name;
    if (state.requiredItems[name]) {
        state.receivedItems[name] = (state.receivedItems[name] || 0) + 1;
        updateMissingItems();
    }
});

// Error handling
bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Kicked: ${reason}`));
bot.on('end', reason => log(`Disconnected: ${reason}`));

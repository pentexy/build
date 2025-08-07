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
    if (state.isBuilding || !state.buildPos || !state.structure) return;
    state.isBuilding = true;

    try {
        log('Starting to build...');
        const blocks = state.structure.blocks.value.value;
        const palette = state.structure.palette.value.value;

        for (const block of blocks) {
            if (!state.isBuilding) break;

            const blockState = palette[block.state.value];
            const blockName = getBlockName(blockState);

            // Skip air blocks
            if (blockName === 'air') continue;

            const position = new Vec3(
                block.pos.value[0] + state.buildPos.x,
                block.pos.value[1] + state.buildPos.y,
                block.pos.value[2] + state.buildPos.z
            );

            // Build scaffold if needed
            if (position.y > bot.entity.position.y + 2) {
                await buildScaffold(position.y);
            }

            const item = bot.inventory.items().find(i => i.name === blockName);
            if (!item) continue;

            try {
                await bot.equip(item, 'hand');
                const referenceBlock = bot.blockAt(position.offset(0, -1, 0)); // Get the block below to use as a reference
                if (referenceBlock) {
                    await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
                    await sleep(CONFIG.buildDelay);
                }
            } catch (err) {
                log(`Building error: ${err.message}`);
            }
        }

        log('!built'); // Signal build completion
    } catch (err) {
        log(`Build failed: ${err.message}`);
    } finally {
        state.isBuilding = false;
        updateMissingItems();
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
                case '!come':
                    if (args.length === 4) {
                        state.buildPos = new Vec3(+args[1], +args[2], +args[3]);
                        await goToPosition(state.buildPos);
                        log('At build location');
                        updateMissingItems();
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

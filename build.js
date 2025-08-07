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
    host: '54.151.198.24', // Your server IP
    port: 25565,
    username: 'BuilderBot',
    buildDelay: 200,
    searchRadius: 10,
    scaffoldBlock: 'dirt',
    schematicUrl: 'https://files.catbox.moe/q1kime.nbt' // Your schematic
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

const findNearbyChest = async (position) => {
    await bot.waitForChunksToLoad();
    const chests = [];
    const start = position.floored();
    
    for (let x = -CONFIG.searchRadius; x <= CONFIG.searchRadius; x++) {
        for (let y = -CONFIG.searchRadius; y <= CONFIG.searchRadius; y++) {
            for (let z = -CONFIG.searchRadius; z <= CONFIG.searchRadius; z++) {
                const checkPos = start.offset(x, y, z);
                const block = bot.blockAt(checkPos);
                if (block && block.name.includes('chest')) {
                    chests.push(block);
                }
            }
        }
    }
    
    return chests.length > 0 ? chests[0].position : null;
};

const downloadSchematic = async () => {
    try {
        log('Loading schematic...');
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
            if (name) state.requiredItems[name] = (state.requiredItems[name] || 0) + 1;
        });

        log(`Loaded schematic requiring: ${Object.keys(state.requiredItems).join(', ')}`);
    } catch (err) {
        log(`Schematic error: ${err.message}`);
    }
};

const getItemsFromChest = async () => {
    if (!state.chestPos) {
        log('No chest position set');
        return false;
    }

    try {
        log('Finding nearby chest...');
        const chestPosition = await findNearbyChest(state.chestPos);
        if (!chestPosition) {
            log('No chest found nearby');
            return false;
        }

        log(`Opening chest at ${chestPosition}`);
        await goToPosition(chestPosition);
        const chestBlock = bot.blockAt(chestPosition);
        
        if (!chestBlock || !chestBlock.name.includes('chest')) {
            log('Chest not found at position');
            return false;
        }

        const chest = await bot.openChest(chestBlock);
        const inventory = scanInventory();
        let gotItems = false;

        for (const [name, needed] of Object.entries(state.requiredItems)) {
            const have = inventory[name] || 0;
            if (have < needed) {
                const items = chest.items().filter(i => i.name === name);
                if (items.length > 0) {
                    const toTake = Math.min(needed - have, items[0].count);
                    await chest.withdraw(items[0].type, null, toTake);
                    log(`Took ${toTake} ${name} from chest`);
                    gotItems = true;
                }
            }
        }
        
        await chest.close();
        return gotItems;
    } catch (err) {
        log(`Chest error: ${err.message}`);
        return false;
    }
};

const buildScaffold = async (targetY) => {
    const scaffoldItem = bot.inventory.items().find(i => i.name === CONFIG.scaffoldBlock);
    if (!scaffoldItem) {
        log(`No ${CONFIG.scaffoldBlock} for scaffolding`);
        return false;
    }

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
    if (state.isBuilding) return;
    state.isBuilding = true;

    try {
        if (!state.buildPos || !state.structure) {
            throw new Error('Set positions and load schematic first');
        }

        // 1. Get items from chest
        await getItemsFromChest();

        // 2. Go to build location
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

            // Build scaffold if needed
            if (position.y > bot.entity.position.y + 2) {
                await buildScaffold(position.y);
            }

            const item = bot.inventory.items().find(i => i.name === blockName);
            if (!item) {
                continue; // Skip missing blocks
            }

            try {
                await bot.equip(item, 'hand');
                await bot.placeBlock(bot.blockAt(position), new Vec3(0, 1, 0));
                await sleep(CONFIG.buildDelay);
            } catch (err) {
                log(`Error placing ${blockName}: ${err.message}`);
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

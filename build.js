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
    host: 'drone-broadness.sg.e4mc.link',
    port: 25565,
    username: 'BuilderBot',
    buildDelay: 200,
    schematicUrl: 'https://files.catbox.me/r7z2gh.nbt',
    chestSearchRadius: 10,
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
};

const specialItems = {
    water: 'water_bucket',
    lava: 'lava_bucket',
    potted_azure_bluet: ['flower_pot', 'azure_bluet']
};

// Helper functions
const log = (message) => {
    console.log(`[BuilderBot] ${message}`);
    bot.chat(message);
};

const getBlockName = (blockState) => {
    return blockState.Name.value.split(':')[1] || blockState.Name.value;
};

const goToPosition = async (position) => {
    const mcData = bot.mcData;
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

const getSingleItemFromChest = async (itemName) => {
    if (!state.chestPos) {
        throw new Error('No chest set. Cannot get items.');
    }

    try {
        await goToPosition(state.chestPos);
        
        const chestBlock = bot.findBlock({
            matching: bot.mcData.blocksByName.chest.id,
            maxDistance: CONFIG.chestSearchRadius,
            point: state.chestPos
        });

        if (!chestBlock) {
            throw new Error('No chest found in the specified radius.');
        }

        const chest = await bot.openChest(chestBlock);
        log(`Searching for ${itemName} in chest...`);
        
        const itemToWithdraw = chest.slots.find(item => item && item.name === itemName);

        if (itemToWithdraw) {
            await chest.withdraw(itemToWithdraw.type, null, 1);
            log(`Withdrew 1 ${itemName} from chest.`);
        } else {
            log(`Could not find ${itemName} in chest.`);
        }
        
        await chest.close();
        await sleep(1000); 
    } catch (err) {
        throw new Error(`Failed to get item from chest: ${err.message}`);
    }
};

const buildStructure = async () => {
    if (state.isBuilding) return;
    state.isBuilding = true;

    try {
        if (!state.buildPos || !state.structure) {
            throw new Error('Set build position and load schematic first. Use !come x y z.');
        }

        const blocks = state.structure.blocks.value.value;
        const palette = state.structure.palette.value.value;
        let blocksPlaced = 0;

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
            
            let item = bot.inventory.findInventoryItem(bot.mcData.blocksByName[blockName]?.id, null, false);
            if (!item) {
                await getSingleItemFromChest(blockName);
                item = bot.inventory.findInventoryItem(bot.mcData.blocksByName[blockName]?.id, null, false);
                if (!item) {
                    log(`Skipping ${blockName} as no matching item was found in inventory or chest.`);
                    continue;
                }
            }
            
            await goToPosition(position);

            const existingBlock = bot.blockAt(position);
            if (existingBlock && existingBlock.name === blockName) {
                continue; 
            }

            try {
                await bot.equip(item, 'hand');
                const referenceBlock = bot.blockAt(position.minus(new Vec3(0, 1, 0)));
                await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
                blocksPlaced++;
                await sleep(CONFIG.buildDelay);
            } catch (err) {
                log(`Building error at ${position.x},${position.y},${position.z}: ${err.message}`);
                await sleep(1000); 
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
                    await buildStructure();
                    break;

                case '!stop':
                    state.isBuilding = false;
                    log('Stopped building');
                    break;

                case '!materials':
                    if (Object.keys(state.requiredItems).length > 0) {
                        const materialsList = [];
                        for (const [name, count] of Object.entries(state.requiredItems)) {
                             const actualItemNames = specialItems[name] || [name];
                             const displayNames = Array.isArray(actualItemNames) ? actualItemNames.join(' & ') : actualItemNames;
                             materialsList.push(`${displayNames}: ${count}`);
                        }
                        log(materialsList.join(', '));
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

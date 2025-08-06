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
    host: 'budget-prior.ap.e4mc.link',
    port: 25565,
    username: 'BuilderBot',
    buildDelay: 200,
    schematicUrl: 'https://files.catbox.moe/r7z2gh.nbt',
    giveAmount: 64, 
    inventoryCheckInterval: 5
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
    inventoryCache: {},
    materialsGathered: false
};

// Helper functions
const log = (message) => {
    console.log(`[BuilderBot] ${message}`);
    bot.chat(message);
};

const getBlockName = (blockState) => {
    return blockState.Name.value.split(':')[1] || blockState.Name.value;
};

const scanInventory = () => {
    state.inventoryCache = {};
    bot.inventory.items().forEach(item => {
        state.inventoryCache[item.name] = (state.inventoryCache[item.name] || 0) + item.count;
    });
};

const getCombinedItemCount = async (itemName) => {
    scanInventory();
    let count = state.inventoryCache[itemName] || 0;
    
    if (state.chestPos) {
        const chestBlock = bot.blockAt(state.chestPos);
        if (chestBlock && chestBlock.name === 'chest') {
            const chest = await bot.openChest(chestBlock);
            const chestItems = chest.items().find(i => i.name === itemName);
            if (chestItems) {
                count += chestItems.count;
            }
            await chest.close();
        }
    }
    return count;
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

const getItemsFromSource = async (itemName, amount) => {
    let have = bot.inventory.findInventoryItem(mcDataLoader(bot.version).blocksByName[itemName].id, null, false)?.count || 0;
    if (have >= amount) {
        return;
    }

    if (state.chestPos) {
        await goToPosition(state.chestPos);
        const chestBlock = bot.blockAt(state.chestPos);
        if (chestBlock && chestBlock.name === 'chest') {
            const chest = await bot.openChest(chestBlock);
            const chestItem = chest.items().find(i => i.name === itemName);
            if (chestItem) {
                const toWithdraw = Math.min(amount - have, chestItem.count);
                if (toWithdraw > 0) {
                    await chest.withdraw(chestItem.type, null, toWithdraw);
                    log(`Withdrew ${toWithdraw} of ${itemName} from chest.`);
                }
            }
            await chest.close();
            await sleep(1000); 
            await goToPosition(state.buildPos);
        }
    } else {
        // If no chest, just use /give
        log(`No chest set. Getting ${itemName} via /give.`);
        const giveAmount = amount - have;
        bot.chat(`/give @s ${itemName} ${giveAmount}`);
        await sleep(2000);
    }
};

const manageChestItems = async () => {
    if (!state.chestPos) {
        log('No chest set. Cannot manage inventory.');
        return;
    }
    
    try {
        await goToPosition(state.chestPos);
        const chestBlock = bot.blockAt(state.chestPos);
        if (chestBlock && chestBlock.name === 'chest') {
            const chest = await bot.openChest(chestBlock);
            for (const item of bot.inventory.items()) {
                if (!state.requiredItems[item.name]) {
                    await chest.deposit(item.type, null, item.count);
                    await sleep(100); 
                }
            }
            await chest.close();
            log('Inventory organized. Excess items placed in chest.');
        }
    } catch (err) {
        log(`Inventory management failed: ${err.message}`);
    }
};

const gatherAllMaterials = async () => {
    if (state.isBuilding) return;
    state.isBuilding = true;

    try {
        if (!state.chestPos) {
            throw new Error('Please set a chest location first using !setchest <x> <y> <z>');
        }
        await goToPosition(state.chestPos);
        
        log('Starting material gathering. I will use /give to get materials and store them in the chest.');

        for (const [name, needed] of Object.entries(state.requiredItems)) {
            let have = await getCombinedItemCount(name);

            while (have < needed) {
                const toGive = Math.min(needed - have, CONFIG.giveAmount);
                log(`Giving myself ${toGive} of ${name}...`);
                bot.chat(`/give @s ${name} ${toGive}`);
                await sleep(2000); // Wait for item to appear
                await manageChestItems();
                have = await getCombinedItemCount(name);
            }
        }
        
        state.materialsGathered = true;
        log('I have gathered all the materials! Run !build again to start building.');
    } catch (err) {
        log(`Material gathering failed: ${err.message}`);
    } finally {
        state.isBuilding = false;
    }
};

const buildStructure = async () => {
    if (state.isBuilding) return;
    state.isBuilding = true;

    try {
        if (!state.buildPos || !state.structure) {
            throw new Error('Set build position and load schematic first. Use !come x y z.');
        }

        log('Starting to build using materials from the chest.');
        await goToPosition(state.buildPos);

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
            
            const existingBlock = bot.blockAt(position);
            if (existingBlock && existingBlock.name === blockName) {
                continue; 
            }

            let item = bot.inventory.findInventoryItem(mcDataLoader(bot.version).blocksByName[blockName].id, null, false);
            if (!item) {
                await getItemsFromSource(blockName, 1);
                item = bot.inventory.findInventoryItem(mcDataLoader(bot.version).blocksByName[blockName].id, null, false);
                if (!item) {
                    log(`Failed to get ${blockName}. Aborting build.`);
                    throw new Error(`Failed to get item: ${blockName}`);
                }
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
                    if (state.materialsGathered) {
                         await buildStructure();
                    } else {
                         await gatherAllMaterials();
                    }
                    break;

                case '!stop':
                    state.isBuilding = false;
                    log('Stopped building');
                    break;

                case '!materials':
                    if (Object.keys(state.requiredItems).length > 0) {
                        log('Required materials:');
                        for (const [name, count] of Object.entries(state.requiredItems)) {
                             log(`${name}: ${count}`);
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

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
    host: '54.151.198.24',
    port: 25565,
    username: 'BuilderBot',
    buildDelay: 100, // Delay between placing blocks
    maxRetries: 3, // Max retries for general operations (not specific to layers now)
    schematicUrl: 'https://files.catbox.moe/r7z2gh.nbt', // URL to your schematic
    schematicFile: 'house.nbt', // Local file name for schematic
    safetyCheck: true, // Not fully implemented, but good to have
    clearInventory: false, // Not fully implemented
    requestItems: true, // Not fully implemented
    layerHeight: 2, // How many layers to build at a time before returning to chest
    scaffoldingBlock: 'dirt' // Block to use for scaffolding
};

const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: 'BuilderBot'
});

bot.loadPlugin(pathfinder);

const state = {
    chestPos: null, // Position of the chest
    buildPos: null, // Starting position for the build
    structure: null, // Loaded schematic data
    requiredItems: {}, // All items needed for the entire schematic
    inventoryItems: {}, // Current items in bot's inventory
    isBuilding: false, // Flag to indicate if building is in progress
    isCollecting: false, // Flag to indicate if collecting is in progress
    missingItems: {}, // Items currently missing for the build
    scaffoldingBlocks: [] // Keep track of placed scaffolding blocks
};

// Helper functions
const log = (message) => {
    console.log(`[${new Date().toISOString()}] ${message}`);
    if (bot && bot.chat) bot.chat(message);
};

// Extracts the block name from a prismarine-nbt block state
const getBlockName = (blockState) => {
    // Example: { Name: { type: 'string', value: 'minecraft:stone' } }
    return blockState.Name.value.split(':')[1] || blockState.Name.value;
};

// Scans the bot's inventory and updates the state.inventoryItems
const scanInventory = () => {
    state.inventoryItems = {};
    bot.inventory.items().forEach(item => {
        state.inventoryItems[item.name] = (state.inventoryItems[item.name] || 0) + item.count;
    });
};

// Moves the bot to a specific position within a given distance
const goToPosition = async (position, distance = 1) => {
    const mcData = mcDataLoader(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalNear(position.x, position.y, position.z, distance));
    
    // Wait until the bot is close enough to the target position
    await new Promise((resolve, reject) => {
        const checkArrival = setInterval(() => {
            // Check if the bot is within the desired distance
            if (bot.entity.position.distanceTo(position) <= distance + 0.5) {
                clearInterval(checkArrival);
                resolve();
            }
        }, 500);

        // Add a timeout to prevent infinite waiting
        setTimeout(() => {
            clearInterval(checkArrival);
            reject(new Error('Failed to reach destination. Pathfinding might be blocked.'));
        }, 30000); // 30 second timeout
    });
};

// Makes the bot look at a specific block position
const faceBlock = async (position) => {
    await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
};

// Downloads the schematic from the configured URL and parses it
const downloadSchematic = async () => {
    try {
        log('Downloading schematic...');
        const res = await fetch(CONFIG.schematicUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const buffer = await res.buffer();
        fs.writeFileSync(CONFIG.schematicFile, buffer); // Save locally
        
        const data = await nbt.parse(buffer);
        state.structure = data.parsed.value;

        // Calculate all required items for the entire schematic
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

// Manages inventory by depositing unneeded items and withdrawing required ones
const manageInventory = async (chestPosition, itemsToWithdraw) => {
    if (!chestPosition) {
        log('Chest position not set. Cannot manage inventory.');
        return false;
    }
    
    try {
        await goToPosition(chestPosition, 1); 
        const chestBlock = bot.blockAt(chestPosition);

        if (!chestBlock || chestBlock.name !== 'chest') {
            log(`Error: No chest found at ${chestPosition.x}, ${chestPosition.y}, ${chestPosition.z}. Found: ${chestBlock ? chestBlock.name : 'nothing'}`);
            return false;
        }
        
        await faceBlock(chestBlock.position);
        const chest = await bot.openChest(chestBlock);
        
        log('Managing inventory...');

        for (const item of bot.inventory.items()) {
            if (!state.requiredItems[item.name] && item.name !== CONFIG.scaffoldingBlock) {
                try {
                    await chest.deposit(item.type, null, item.count);
                    log(`Deposited ${item.count}x ${item.name} to chest.`);
                    await sleep(100);
                } catch (err) {
                    log(`Failed to deposit ${item.name}: ${err.message}`);
                }
            }
        }
        
        scanInventory();
        let successfulWithdrawal = true;
        for (const [name, needed] of Object.entries(itemsToWithdraw)) {
            const have = state.inventoryItems[name] || 0;
            if (have < needed) {
                const itemsInChest = chest.items().filter(i => i.name === name);
                if (itemsInChest.length > 0) {
                    const toTake = Math.min(needed - have, itemsInChest[0].count);
                    await chest.withdraw(itemsInChest[0].type, null, toTake);
                    log(`Withdrew ${toTake}x ${name} from chest.`);
                    await sleep(100);
                } else {
                    log(`Warning: ${name} not found in chest for withdrawal. Cannot complete this section.`);
                    successfulWithdrawal = false;
                }
            }
        }
        
        await chest.close();
        log('Inventory management complete.');
        return successfulWithdrawal;
    } catch (err) {
        log(`Chest interaction error: ${err.message}`);
        return false;
    }
};

// Collects nearby dropped items that are needed for the build
const collectNearbyItems = async () => {
    if (state.isBuilding) return;
    state.isCollecting = true;
    log('Scanning for nearby items to collect...');
    const items = Object.values(bot.entities).filter(e => e.type === 'item');
    let collectedCount = 0;
    for (const item of items) {
        if (item.name && state.requiredItems[item.name]) {
            log(`Going to collect ${item.name} at ${item.position.x}, ${item.position.y}, ${item.position.z}`);
            await goToPosition(item.position, 2);
            await sleep(500);
            collectedCount++;
        }
    }
    if (collectedCount > 0) {
        log(`Collected ${collectedCount} nearby items.`);
    } else {
        log('No relevant items found nearby.');
    }
    state.isCollecting = false;
};

// Calculates items needed for a specific range of Y-coordinates (layers)
const calculateItemsForLayers = (minY, maxY) => {
    const items = {};
    if (!state.structure) return items;

    state.structure.blocks.value.value.forEach(block => {
        const blockY = block.pos.value[1];
        if (blockY >= minY && blockY < maxY) {
            const blockState = state.structure.palette.value.value[block.state.value];
            const name = getBlockName(blockState);
            items[name] = (items[name] || 0) + 1;
        }
    });
    return items;
};

// Helper to check what's truly missing from current inventory for a given set of required items
const getMissingItemsInInventory = (requiredForLayer) => {
    const missing = {};
    scanInventory();
    for (const [name, needed] of Object.entries(requiredForLayer)) {
        const have = state.inventoryItems[name] || 0;
        if (have < needed) {
            missing[name] = needed - have;
        }
    }
    return missing;
};

// Places scaffolding blocks to reach higher positions
const placeScaffolding = async (targetPos) => {
    const botCurrentY = bot.entity.position.y;
    const targetBlockY = targetPos.y;
    const horizontalDistance = bot.entity.position.distanceTo(targetPos.clone().setY(botCurrentY));

    if (targetBlockY > botCurrentY + 2 || horizontalDistance > 3) {
        log(`Scaffolding needed to reach Y: ${targetBlockY} (Bot Y: ${botCurrentY.toFixed(1)}, Horiz Dist: ${horizontalDistance.toFixed(1)})`);
        
        const scaffoldingItem = bot.inventory.items().find(i => i.name === CONFIG.scaffoldingBlock);
        if (!scaffoldingItem) {
            log(`Error: No ${CONFIG.scaffoldingBlock} in inventory for scaffolding! Cannot reach target.`);
            return false;
        }

        state.scaffoldingBlocks = state.scaffoldingBlocks.filter(pos => pos.y >= botCurrentY - 1);

        let currentScaffoldHeight = Math.floor(botCurrentY);
        const botX = Math.floor(bot.entity.position.x);
        const botZ = Math.floor(bot.entity.position.z);

        while (currentScaffoldHeight < targetBlockY - 1) {
            const scaffoldBlockPos = new Vec3(botX, currentScaffoldHeight, botZ);
            const blockAtScaffoldPos = bot.blockAt(scaffoldBlockPos);

            if (blockAtScaffoldPos.name === 'air') {
                try {
                    const referenceBlockForScaffold = bot.blockAt(scaffoldBlockPos.offset(0, -1, 0));
                    if (!referenceBlockForScaffold || referenceBlockForScaffold.name === 'air') {
                        log(`No direct support for scaffolding at ${scaffoldBlockPos}, trying to find adjacent support.`);
                        const adjacentBlock = bot.blockAt(scaffoldBlockPos.offset(1, -1, 0));
                        if (adjacentBlock && adjacentBlock.name !== 'air') {
                            await goToPosition(adjacentBlock.position, 1);
                        } else {
                            log(`Could not find a suitable reference block to place scaffolding at ${scaffoldBlockPos}.`);
                            return false;
                        }
                    } else {
                        await goToPosition(referenceBlockForScaffold.position, 1);
                    }
                   
                    await bot.equip(scaffoldingItem, 'hand');
                    await bot.placeBlock(bot.blockAt(scaffoldBlockPos.offset(0, -1, 0)), new Vec3(0, 1, 0));
                    state.scaffoldingBlocks.push(scaffoldBlockPos);
                    log(`Placed scaffolding at ${scaffoldBlockPos}`);
                    await sleep(CONFIG.buildDelay);
                    currentScaffoldHeight++;
                } catch (err) {
                    log(`Failed to place scaffolding block at ${scaffoldBlockPos}: ${err.message}`);
                    return false;
                }
            } else {
                currentScaffoldHeight++;
            }
        }

        const targetScaffoldTop = new Vec3(botX, currentScaffoldHeight + 1, botZ);
        await goToPosition(targetScaffoldTop, 0.5);
        log(`Climbed to Y: ${bot.entity.position.y.toFixed(1)}`);
        return true;
    }
    return true;
};

// Removes placed scaffolding blocks
const removeScaffolding = async () => {
    if (state.scaffoldingBlocks.length === 0) return;

    log('Removing scaffolding...');
    for (let i = state.scaffoldingBlocks.length - 1; i >= 0; i--) {
        const pos = state.scaffoldingBlocks[i];
        const block = bot.blockAt(pos);
        if (block && block.name === CONFIG.scaffoldingBlock) {
            try {
                await goToPosition(pos, 2);
                await bot.dig(block);
                log(`Removed scaffolding at ${pos}`);
                await sleep(CONFIG.buildDelay);
            } catch (err) {
                log(`Failed to remove scaffolding at ${pos}: ${err.message}`);
            }
        }
    }
    state.scaffoldingBlocks = [];
};

// Main building function, now handles layering and scaffolding
const buildStructure = async () => {
    if (state.isBuilding) {
        log('Already building!');
        return;
    }
    state.isBuilding = true;

    try {
        if (!state.buildPos || !state.structure) {
            throw new Error('Set build position and load schematic first.');
        }

        log('Starting layered building process...');

        const blocks = state.structure.blocks.value.value;
        const palette = state.structure.palette.value.value;

        blocks.sort((a, b) => a.pos.value[1] - b.pos.value[1]);

        const minSchematicY = blocks[0].pos.value[1];
        const maxSchematicY = blocks[blocks.length - 1].pos.value[1];

        let buildSuccessfullyCompleted = true;
        let skippedBlocks = {};

        for (let currentLayerY = minSchematicY; currentLayerY <= maxSchematicY; currentLayerY += CONFIG.layerHeight) {
            if (!state.isBuilding) {
                log('Building stopped by command.');
                buildSuccessfullyCompleted = false;
                break;
            }

            const nextLayerY = currentLayerY + CONFIG.layerHeight;
            log(`Preparing for layers Y: ${currentLayerY} to ${nextLayerY - 1}`);
            
            const itemsForCurrentLayers = calculateItemsForLayers(currentLayerY, nextLayerY);
            
            const inventoryReadyFromChest = await manageInventory(state.chestPos, itemsForCurrentLayers);
            
            if (!inventoryReadyFromChest) {
                log(`Cannot acquire all necessary items from the chest for this layer. Continuing to build with available items.`);
            }
            
            const missingInCurrentInventory = getMissingItemsInInventory(itemsForCurrentLayers);

            if (Object.keys(missingInCurrentInventory).length > 0) {
                log(`Still missing items in inventory for layers Y: ${currentLayerY} to ${nextLayerY - 1}. Please provide them for a complete build:`);
                for (const [item, amount] of Object.entries(missingInCurrentInventory)) {
                    log(`/give @s ${item} ${amount}`);
                }
            }

            const blocksInCurrentLayers = blocks.filter(block =>
                block.pos.value[1] >= currentLayerY && block.pos.value[1] < nextLayerY
            );

            for (const block of blocksInCurrentLayers) {
                if (!state.isBuilding) break;

                const blockState = palette[block.state.value];
                const blockName = getBlockName(blockState);
                const position = new Vec3(
                    block.pos.value[0] + state.buildPos.x,
                    block.pos.value[1] + state.buildPos.y,
                    block.pos.value[2] + state.buildPos.z
                );
                
                const existingBlock = bot.blockAt(position);
                if (existingBlock && existingBlock.name === blockName) {
                    continue;
                }
                
                const item = bot.inventory.items().find(i => i.name === blockName);
                if (!item) {
                    log(`Skipping ${blockName} at ${position.x}, ${position.y}, ${position.z} as no matching item was found in inventory.`);
                    skippedBlocks[blockName] = (skippedBlocks[blockName] || 0) + 1;
                    continue; // Skip this block and continue to the next one
                }

                await goToPosition(position, 4);
                const scaffoldingNeeded = await placeScaffolding(position);
                if (!scaffoldingNeeded) {
                    log(`Could not place scaffolding for ${position}. Skipping block.`);
                    skippedBlocks[blockName] = (skippedBlocks[blockName] || 0) + 1;
                    continue;
                }

                try {
                    await bot.equip(item, 'hand');
                    
                    let referenceBlock = bot.blockAt(position.offset(0, -1, 0));
                    if (!referenceBlock || referenceBlock.name === 'air') {
                        const potentialReferences = [
                            position.offset(1, 0, 0), position.offset(-1, 0, 0),
                            position.offset(0, 0, 1), position.offset(0, 0, -1)
                        ];
                        for (const refPos of potentialReferences) {
                            const b = bot.blockAt(refPos);
                            if (b && b.name !== 'air') {
                                referenceBlock = b;
                                break;
                            }
                        }
                    }

                    if (!referenceBlock || referenceBlock.name === 'air') {
                        log(`No suitable reference block found for ${blockName} at ${position}. Skipping.`);
                        skippedBlocks[blockName] = (skippedBlocks[blockName] || 0) + 1;
                        continue;
                    }

                    const faceVector = position.minus(referenceBlock.position);

                    await bot.placeBlock(referenceBlock, faceVector);
                    log(`Placed ${blockName} at ${position.x}, ${position.y}, ${position.z}`);
                    await sleep(CONFIG.buildDelay);
                } catch (err) {
                    log(`Building error at ${position}: ${err.message}`);
                } finally {
                    await removeScaffolding();
                }
            }
            log(`Completed layer Y: ${currentLayerY} to ${nextLayerY - 1}.`);
        }

        if (buildSuccessfullyCompleted) {
            log('Build complete ✅');
            if (Object.keys(skippedBlocks).length > 0) {
                log('Note: The following blocks were skipped due to missing items:');
                for (const [item, count] of Object.entries(skippedBlocks)) {
                    log(`- ${item}: ${count} blocks`);
                }
            }
        } else {
            log('Build halted or partially completed due to issues or stop command. Check logs for missing items or errors.');
        }
    } catch (err) {
        log(`Build failed: ${err.message}`);
        buildSuccessfullyCompleted = false;
    } finally {
        state.isBuilding = false;
        await removeScaffolding();
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
                    log(`Chest position set to ${state.chestPos.x}, ${state.chestPos.y}, ${state.chestPos.z}`);
                } else {
                    log('Usage: !setchest <x> <y> <z>');
                }
                break;

            case '!come':
                if (args.length === 4) {
                    state.buildPos = new Vec3(+args[1], +args[2], +args[3]);
                    log(`Build position set to ${state.buildPos.x}, ${state.buildPos.y}, ${state.buildPos.z}. Going there now.`);
                    await goToPosition(state.buildPos);
                } else {
                    log('Usage: !come <x> <y> <z>');
                }
                break;

            case '!build':
                if (!state.buildPos) {
                    log('Please set the build position first using !come <x> <y> <z>.');
                    return;
                }
                if (!state.chestPos) {
                    log('Please set the chest position first using !setchest <x> <y> <z>.');
                    return;
                }
                if (!state.structure) {
                    log('Schematic not loaded. Please wait or check schematic URL.');
                    return;
                }
                await buildStructure();
                break;

            case '!materials':
                log('Checking materials and managing inventory...');
                const allRequired = calculateItemsForLayers(0, state.structure.size.value[1]);
                const chestCheckSuccessful = await manageInventory(state.chestPos, allRequired);
                
                const missingOverall = getMissingItemsInInventory(allRequired);
                
                if (Object.keys(missingOverall).length > 0) {
                    log('Still missing items (use /give @s <item> <amount>):');
                    for (const [item, amount] of Object.entries(missingOverall)) {
                        log(`/give @s ${item} ${amount}`);
                    }
                } else {
                    log('All required materials are in inventory or chest!');
                }
                break;

            case '!collect':
                await collectNearbyItems();
                break;

            case '!stop':
                state.isBuilding = false;
                log('Stopped current action. Finishing current block placement/removal.');
                break;

            case '!help':
                log('Commands: !setchest x y z, !come x y z, !build, !materials, !collect, !stop, !help');
                break;

            default:
                log(`Unknown command: ${cmd}. Type !help for commands.`);
                break;
        }
    } catch (err) {
        log(`Command execution error: ${err.message}`);
    }
};

bot.on('chat', (username, message) => {
    handleCommand(username, message).catch(err => {
        log(`Error handling command: ${err.message}`);
    });
});

bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Bot kicked: ${reason}`));
bot.on('end', reason => log(`Bot disconnected: ${reason}`));

setInterval(async () => {
    if (!state.isBuilding && !state.isCollecting) {
        await collectNearbyItems();
    }
}, 30000);

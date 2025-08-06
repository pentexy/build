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
    host: '18.143.129.103',
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
    username: CONFIG.username
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
    await new Promise((resolve) => {
        const checkArrival = setInterval(() => {
            // Check if the bot is within the desired distance
            if (bot.entity.position.distanceTo(position) <= distance + 0.5) {
                clearInterval(checkArrival);
                resolve();
            }
            // Add a timeout to prevent infinite waiting if path is blocked
            // (More advanced error handling for pathfinding could be added here)
        }, 500);
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
        // Go very close to the chest block
        await goToPosition(chestPosition, 1); 
        const chestBlock = bot.blockAt(chestPosition);

        // Explicitly check if the block exists and is a chest
        if (!chestBlock || chestBlock.name !== 'chest') {
            log(`Error: No chest found at ${chestPosition.x}, ${chestPosition.y}, ${chestPosition.z}. Found: ${chestBlock ? chestBlock.name : 'nothing'}`);
            return false;
        }
        
        await faceBlock(chestBlock.position); // Face the chest before opening
        const chest = await bot.openChest(chestBlock);
        
        log('Managing inventory...');

        // 1. Deposit all non-building items (items not in state.requiredItems and not scaffolding)
        for (const item of bot.inventory.items()) {
            if (!state.requiredItems[item.name] && item.name !== CONFIG.scaffoldingBlock) {
                try {
                    await chest.deposit(item.type, null, item.count);
                    log(`Deposited ${item.count}x ${item.name} to chest.`);
                    await sleep(100); // Small delay to prevent rate limiting
                } catch (err) {
                    log(`Failed to deposit ${item.name}: ${err.message}`);
                }
            }
        }
        
        // 2. Withdraw needed items for the current building phase
        scanInventory(); // Rescan inventory after depositing
        for (const [name, needed] of Object.entries(itemsToWithdraw)) {
            const have = state.inventoryItems[name] || 0;
            if (have < needed) {
                const itemsInChest = chest.items().filter(i => i.name === name);
                if (itemsInChest.length > 0) {
                    const toTake = Math.min(needed - have, itemsInChest[0].count);
                    await chest.withdraw(itemsInChest[0].type, null, toTake);
                    log(`Withdrew ${toTake}x ${name} from chest.`);
                    await sleep(100); // Small delay
                } else {
                    log(`Warning: ${name} not found in chest for withdrawal.`);
                }
            }
        }
        
        await chest.close();
        log('Inventory management complete.');
        return true;
    } catch (err) {
        log(`Chest interaction error: ${err.message}`);
        return false;
    }
};

// Collects nearby dropped items that are needed for the build
const collectNearbyItems = async () => {
    if (state.isBuilding) return; // Don't collect if building
    state.isCollecting = true;
    log('Scanning for nearby items to collect...');
    const items = Object.values(bot.entities).filter(e => e.type === 'item');
    let collectedCount = 0;
    for (const item of items) {
        // Use item.name directly, assuming it's usually available.
        // The more complex NBT parsing is generally for specific item data, not just name.
        if (item.name && state.requiredItems[item.name]) { 
            log(`Going to collect ${item.name} at ${item.position.x}, ${item.position.y}, ${item.position.z}`);
            await goToPosition(item.position, 2); // Go close to the item
            await sleep(500); // Wait for item collection animation
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
    scanInventory(); // Always rescan before checking
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

    // If target is significantly higher (more than 2 blocks) or too far horizontally (more than 3 blocks)
    if (targetBlockY > botCurrentY + 2 || horizontalDistance > 3) {
        log(`Scaffolding needed to reach Y: ${targetBlockY} (Bot Y: ${botCurrentY.toFixed(1)}, Horiz Dist: ${horizontalDistance.toFixed(1)})`);
        
        const scaffoldingItem = bot.inventory.items().find(i => i.name === CONFIG.scaffoldingBlock);
        if (!scaffoldingItem) {
            log(`Error: No ${CONFIG.scaffoldingBlock} in inventory for scaffolding! Cannot reach target.`);
            return false;
        }

        // Filter out scaffolding blocks that are already below the bot's current Y, as they might be removed or no longer relevant.
        state.scaffoldingBlocks = state.scaffoldingBlocks.filter(pos => pos.y >= botCurrentY - 1);

        let currentScaffoldHeight = Math.floor(botCurrentY); // Start building from bot's current Y level
        const botX = Math.floor(bot.entity.position.x);
        const botZ = Math.floor(bot.entity.position.z);

        while (currentScaffoldHeight < targetBlockY - 1) { // Build up to one block below the target block
            const scaffoldBlockPos = new Vec3(botX, currentScaffoldHeight, botZ);
            const blockAtScaffoldPos = bot.blockAt(scaffoldBlockPos);

            if (blockAtScaffoldPos.name === 'air') { // If the spot is empty, place a block
                try {
                    // Go to a position where the bot can place the scaffolding block
                    // This often means standing on the block below the target scaffolding spot
                    const referenceBlockForScaffold = bot.blockAt(scaffoldBlockPos.offset(0, -1, 0));
                    if (!referenceBlockForScaffold || referenceBlockForScaffold.name === 'air') {
                        // If no direct support below, try to find an adjacent block to stand on
                        log(`No direct support for scaffolding at ${scaffoldBlockPos}, trying to find adjacent support.`);
                        const adjacentBlock = bot.blockAt(scaffoldBlockPos.offset(1, -1, 0)); // Example: try one block to the side
                        if (adjacentBlock && adjacentBlock.name !== 'air') {
                            await goToPosition(adjacentBlock.position, 1);
                        } else {
                            log(`Could not find a suitable reference block to place scaffolding at ${scaffoldBlockPos}.`);
                            return false; // Cannot place scaffolding
                        }
                    } else {
                        await goToPosition(referenceBlockForScaffold.position, 1); // Stand on the block below
                    }
                   
                    await bot.equip(scaffoldingItem, 'hand');
                    await bot.placeBlock(bot.blockAt(scaffoldBlockPos.offset(0, -1, 0)), new Vec3(0, 1, 0)); // Place on top of the reference
                    state.scaffoldingBlocks.push(scaffoldBlockPos);
                    log(`Placed scaffolding at ${scaffoldBlockPos}`);
                    await sleep(CONFIG.buildDelay);
                    currentScaffoldHeight++;
                } catch (err) {
                    log(`Failed to place scaffolding block at ${scaffoldBlockPos}: ${err.message}`);
                    return false;
                }
            } else {
                currentScaffoldHeight++; // Block already exists, move up
            }
        }
        // After placing scaffolding, try to move bot to the top of the scaffolding
        // This uses pathfinder to climb the placed scaffolding
        const targetScaffoldTop = new Vec3(botX, currentScaffoldHeight + 1, botZ);
        await goToPosition(targetScaffoldTop, 0.5); // Move to top of scaffolding
        log(`Climbed to Y: ${bot.entity.position.y.toFixed(1)}`);
        return true;
    }
    return true; // No scaffolding needed
};


// Removes placed scaffolding blocks
const removeScaffolding = async () => {
    if (state.scaffoldingBlocks.length === 0) return;

    log('Removing scaffolding...');
    // Remove in reverse order (top to bottom)
    for (let i = state.scaffoldingBlocks.length - 1; i >= 0; i--) {
        const pos = state.scaffoldingBlocks[i];
        const block = bot.blockAt(pos);
        if (block && block.name === CONFIG.scaffoldingBlock) {
            try {
                await goToPosition(pos, 2); // Go near the scaffolding block
                await bot.dig(block);
                log(`Removed scaffolding at ${pos}`);
                await sleep(CONFIG.buildDelay);
            } catch (err) {
                log(`Failed to remove scaffolding at ${pos}: ${err.message}`);
            }
        }
    }
    state.scaffoldingBlocks = []; // Clear the list
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

        // Sort blocks by Y-coordinate to build from bottom up
        blocks.sort((a, b) => a.pos.value[1] - b.pos.value[1]);

        const minSchematicY = blocks[0].pos.value[1];
        const maxSchematicY = blocks[blocks.length - 1].pos.value[1];

        // Flag to track if the entire build was completed successfully
        let buildSuccessfullyCompleted = true;

        for (let currentLayerY = minSchematicY; currentLayerY <= maxSchematicY; currentLayerY += CONFIG.layerHeight) {
            if (!state.isBuilding) {
                log('Building stopped by command.');
                buildSuccessfullyCompleted = false; // Mark as not fully completed
                break; // Break outer loop if stop command is issued
            }

            const nextLayerY = currentLayerY + CONFIG.layerHeight;
            log(`Preparing for layers Y: ${currentLayerY} to ${nextLayerY - 1}`);

            let needsMoreItemsForLayer = true; // Flag to control re-attempting layer
            let retryCount = 0;
            const MAX_LAYER_RETRIES = 5; // Prevent infinite loops if items are truly unavailable

            while (needsMoreItemsForLayer && retryCount < MAX_LAYER_RETRIES) {
                needsMoreItemsForLayer = false; // Assume success for this attempt
                retryCount++;

                // Calculate items needed for the current set of layers for inventory check
                const itemsForCurrentLayers = calculateItemsForLayers(currentLayerY, nextLayerY);
                
                // --- Step 1: Try to get items from chest ---
                const inventoryReadyFromChest = await manageInventory(state.chestPos, itemsForCurrentLayers);
                if (!inventoryReadyFromChest) {
                    log(`Failed to get required items from chest for layers Y: ${currentLayerY} to ${nextLayerY - 1}. Retrying (${retryCount}/${MAX_LAYER_RETRIES})...`);
                    needsMoreItemsForLayer = true; // Need to retry
                    await sleep(5000); // Wait before next attempt
                    continue; // Continue while loop to retry inventory
                }
                
                // --- Step 2: Check current inventory against what's needed for this layer ---
                const missingInCurrentInventory = getMissingItemsInInventory(itemsForCurrentLayers);

                if (Object.keys(missingInCurrentInventory).length > 0) {
                    log(`Still missing items in inventory for layers Y: ${currentLayerY} to ${nextLayerY - 1}.`);
                    for (const [item, amount] of Object.entries(missingInCurrentInventory)) {
                        log(`/give @s ${item} ${amount}`); // Suggest /give command
                    }
                    log(`Please provide these items. Retrying layer in 10 seconds (${retryCount}/${MAX_LAYER_RETRIES})...`);
                    needsMoreItemsForLayer = true; // Need to retry
                    await sleep(10000); // Wait longer for user to provide items
                    continue; // Continue while loop to retry inventory
                }

                // If we reach here, inventory *should* be ready for this layer.
                // Proceed with placing blocks.
                const blocksInCurrentLayers = blocks.filter(block =>
                    block.pos.value[1] >= currentLayerY && block.pos.value[1] < nextLayerY
                );

                for (const block of blocksInCurrentLayers) {
                    if (!state.isBuilding) break; // If stop command issued, break all loops

                    const blockState = palette[block.state.value];
                    const blockName = getBlockName(blockState);
                    const position = new Vec3(
                        block.pos.value[0] + state.buildPos.x,
                        block.pos.value[1] + state.buildPos.y, // Corrected Y-coordinate calculation
                        block.pos.value[2] + state.buildPos.z
                    );

                    // Check if the block already exists and is correct
                    const existingBlock = bot.blockAt(position);
                    if (existingBlock && existingBlock.name === blockName) {
                        continue; // Skip if already placed
                    }
                    
                    // Ensure bot has the item *before* trying to equip
                    const item = bot.inventory.items().find(i => i.name === blockName);
                    if (!item) {
                        log(`Ran out of ${blockName} for ${position} mid-layer. Need to get more items. Re-evaluating layer.`);
                        needsMoreItemsForLayer = true; // Set flag to retry this layer
                        break; // Break inner block loop to go to outer while loop
                    }

                    // Go to position and place scaffolding if needed
                    await goToPosition(position, 4); // Go generally near the target
                    const scaffoldingNeeded = await placeScaffolding(position);
                    if (!scaffoldingNeeded) {
                        log(`Could not place scaffolding for ${position}. Skipping block.`);
                        continue; // Skip this block, but continue with the layer
                    }

                    try {
                        await bot.equip(item, 'hand');
                        
                        // Find a reference block to place on
                        let referenceBlock = bot.blockAt(position.offset(0, -1, 0)); // Try directly below
                        if (!referenceBlock || referenceBlock.name === 'air') {
                            // If no block directly below, try adjacent blocks on the same Y-level
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
                            continue;
                        }

                        // Calculate face to place on (usually top of reference block)
                        const faceVector = position.minus(referenceBlock.position);

                        await bot.placeBlock(referenceBlock, faceVector);
                        log(`Placed ${blockName} at ${position.x}, ${position.y}, ${position.z}`);
                        await sleep(CONFIG.buildDelay);
                    } catch (err) {
                        log(`Building error at ${position}: ${err.message}`);
                        // Consider retrying or skipping this block
                    } finally {
                        // Always try to remove scaffolding after placing the block
                        await removeScaffolding();
                    }
                } // End of blocksInCurrentLayers loop

                if (needsMoreItemsForLayer) {
                    // If we broke out of the inner loop due to missing items,
                    // the while loop will re-run for the same layer.
                    log(`Re-attempting layer Y: ${currentLayerY} due to missing items.`);
                } else {
                    // If we completed the inner loop without needing more items,
                    // then this layer is done, and the while loop can exit.
                    log(`Completed layer Y: ${currentLayerY} to ${nextLayerY - 1}.`);
                }
            } // End of while (needsMoreItemsForLayer) loop

            if (retryCount >= MAX_LAYER_RETRIES && needsMoreItemsForLayer) {
                log(`Max retries (${MAX_LAYER_RETRIES}) reached for layers Y: ${currentLayerY} to ${nextLayerY - 1}. Cannot complete this section due to persistent missing items.`);
                buildSuccessfullyCompleted = false; // Mark as not fully completed
                break; // Break the outer for loop if max retries reached
            }
        } // End of currentLayerY loop

        if (buildSuccessfullyCompleted) {
            log('Build complete ✅');
        } else {
            log('Build halted or partially completed due to issues or stop command. Check logs for missing items or errors.');
        }
    } catch (err) {
        log(`Build failed: ${err.message}`);
        buildSuccessfullyCompleted = false; // Mark as not fully completed
    } finally {
        state.isBuilding = false;
        await removeScaffolding(); // Ensure all scaffolding is removed at the end
    }
};

// Event handlers
bot.once('spawn', async () => {
    log('Bot spawned!');
    await downloadSchematic();
});

const handleCommand = async (username, message) => {
    if (username === bot.username) return; // Ignore bot's own messages

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
                // This command can now trigger a full inventory check and request
                log('Checking materials and managing inventory...');
                const allRequired = calculateItemsForLayers(0, state.structure.size.value[1]); // Get all items
                await manageInventory(state.chestPos, allRequired); // Try to get from chest first
                
                const missingOverall = getMissingItemsInInventory(allRequired); // Check what's still missing after chest interaction
                
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
    });
};

bot.on('chat', (username, message) => {
    handleCommand(username, message).catch(err => {
        log(`Error handling command: ${err.message}`);
    });
});

bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Bot kicked: ${reason}`));
bot.on('end', reason => log(`Bot disconnected: ${reason}`));

// Collect nearby items periodically (when not building or already collecting)
setInterval(async () => {
    if (!state.isBuilding && !state.isCollecting) {
        await collectNearbyItems();
    }
}, 30000); // Every 30 seconds
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
        // Go very close to the chest block
        await goToPosition(chestPosition, 1); 
        const chestBlock = bot.blockAt(chestPosition);

        // Explicitly check if the block exists and is a chest
        if (!chestBlock || chestBlock.name !== 'chest') {
            log(`Error: No chest found at ${chestPosition.x}, ${chestPosition.y}, ${chestPosition.z}. Found: ${chestBlock ? chestBlock.name : 'nothing'}`);
            return false;
        }
        
        await faceBlock(chestBlock.position); // Face the chest before opening
        const chest = await bot.openChest(chestBlock);
        
        log('Managing inventory...');

        // 1. Deposit all non-building items (items not in state.requiredItems and not scaffolding)
        for (const item of bot.inventory.items()) {
            if (!state.requiredItems[item.name] && item.name !== CONFIG.scaffoldingBlock) {
                try {
                    await chest.deposit(item.type, null, item.count);
                    log(`Deposited ${item.count}x ${item.name} to chest.`);
                    await sleep(100); // Small delay to prevent rate limiting
                } catch (err) {
                    log(`Failed to deposit ${item.name}: ${err.message}`);
                }
            }
        }
        
        // 2. Withdraw needed items for the current building phase
        scanInventory(); // Rescan inventory after depositing
        for (const [name, needed] of Object.entries(itemsToWithdraw)) {
            const have = state.inventoryItems[name] || 0;
            if (have < needed) {
                const itemsInChest = chest.items().filter(i => i.name === name);
                if (itemsInChest.length > 0) {
                    const toTake = Math.min(needed - have, itemsInChest[0].count);
                    await chest.withdraw(itemsInChest[0].type, null, toTake);
                    log(`Withdrew ${toTake}x ${name} from chest.`);
                    await sleep(100); // Small delay
                } else {
                    log(`Warning: ${name} not found in chest for withdrawal.`);
                }
            }
        }
        
        await chest.close();
        log('Inventory management complete.');
        return true;
    } catch (err) {
        log(`Chest interaction error: ${err.message}`);
        return false;
    }
};

// Collects nearby dropped items that are needed for the build
const collectNearbyItems = async () => {
    if (state.isBuilding) return; // Don't collect if building
    state.isCollecting = true;
    log('Scanning for nearby items to collect...');
    const items = Object.values(bot.entities).filter(e => e.type === 'item');
    let collectedCount = 0;
    for (const item of items) {
        // Use item.name directly, assuming it's usually available.
        // The more complex NBT parsing is generally for specific item data, not just name.
        if (item.name && state.requiredItems[item.name]) { 
            log(`Going to collect ${item.name} at ${item.position.x}, ${item.position.y}, ${item.position.z}`);
            await goToPosition(item.position, 2); // Go close to the item
            await sleep(500); // Wait for item collection animation
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

// Places scaffolding blocks to reach higher positions
const placeScaffolding = async (targetPos) => {
    const botCurrentY = bot.entity.position.y;
    const targetBlockY = targetPos.y;
    const horizontalDistance = bot.entity.position.distanceTo(targetPos.clone().setY(botCurrentY));

    // If target is significantly higher (more than 2 blocks) or too far horizontally (more than 3 blocks)
    if (targetBlockY > botCurrentY + 2 || horizontalDistance > 3) {
        log(`Scaffolding needed to reach Y: ${targetBlockY} (Bot Y: ${botCurrentY.toFixed(1)}, Horiz Dist: ${horizontalDistance.toFixed(1)})`);
        
        const scaffoldingItem = bot.inventory.items().find(i => i.name === CONFIG.scaffoldingBlock);
        if (!scaffoldingItem) {
            log(`Error: No ${CONFIG.scaffoldingBlock} in inventory for scaffolding! Cannot reach target.`);
            return false;
        }

        // Filter out scaffolding blocks that are already below the bot's current Y, as they might be removed or no longer relevant.
        state.scaffoldingBlocks = state.scaffoldingBlocks.filter(pos => pos.y >= botCurrentY - 1);

        let currentScaffoldHeight = Math.floor(botCurrentY); // Start building from bot's current Y level
        const botX = Math.floor(bot.entity.position.x);
        const botZ = Math.floor(bot.entity.position.z);

        while (currentScaffoldHeight < targetBlockY - 1) { // Build up to one block below the target block
            const scaffoldBlockPos = new Vec3(botX, currentScaffoldHeight, botZ);
            const blockAtScaffoldPos = bot.blockAt(scaffoldBlockPos);

            if (blockAtScaffoldPos.name === 'air') { // If the spot is empty, place a block
                try {
                    // Go to a position where the bot can place the scaffolding block
                    // This often means standing on the block below the target scaffolding spot
                    const referenceBlockForScaffold = bot.blockAt(scaffoldBlockPos.offset(0, -1, 0));
                    if (!referenceBlockForScaffold || referenceBlockForScaffold.name === 'air') {
                        // If no direct support below, try to find an adjacent block to stand on
                        log(`No direct support for scaffolding at ${scaffoldBlockPos}, trying to find adjacent support.`);
                        const adjacentBlock = bot.blockAt(scaffoldBlockPos.offset(1, -1, 0)); // Example: try one block to the side
                        if (adjacentBlock && adjacentBlock.name !== 'air') {
                            await goToPosition(adjacentBlock.position, 1);
                        } else {
                            log(`Could not find a suitable reference block to place scaffolding at ${scaffoldBlockPos}.`);
                            return false; // Cannot place scaffolding
                        }
                    } else {
                        await goToPosition(referenceBlockForScaffold.position, 1); // Stand on the block below
                    }
                   
                    await bot.equip(scaffoldingItem, 'hand');
                    await bot.placeBlock(bot.blockAt(scaffoldBlockPos.offset(0, -1, 0)), new Vec3(0, 1, 0)); // Place on top of the reference
                    state.scaffoldingBlocks.push(scaffoldBlockPos);
                    log(`Placed scaffolding at ${scaffoldBlockPos}`);
                    await sleep(CONFIG.buildDelay);
                    currentScaffoldHeight++;
                } catch (err) {
                    log(`Failed to place scaffolding block at ${scaffoldBlockPos}: ${err.message}`);
                    return false;
                }
            } else {
                currentScaffoldHeight++; // Block already exists, move up
            }
        }
        // After placing scaffolding, try to move bot to the top of the scaffolding
        // This uses pathfinder to climb the placed scaffolding
        const targetScaffoldTop = new Vec3(botX, currentScaffoldHeight + 1, botZ);
        await goToPosition(targetScaffoldTop, 0.5); // Move to top of scaffolding
        log(`Climbed to Y: ${bot.entity.position.y.toFixed(1)}`);
        return true;
    }
    return true; // No scaffolding needed
};


// Removes placed scaffolding blocks
const removeScaffolding = async () => {
    if (state.scaffoldingBlocks.length === 0) return;

    log('Removing scaffolding...');
    // Remove in reverse order (top to bottom)
    for (let i = state.scaffoldingBlocks.length - 1; i >= 0; i--) {
        const pos = state.scaffoldingBlocks[i];
        const block = bot.blockAt(pos);
        if (block && block.name === CONFIG.scaffoldingBlock) {
            try {
                await goToPosition(pos, 2); // Go near the scaffolding block
                await bot.dig(block);
                log(`Removed scaffolding at ${pos}`);
                await sleep(CONFIG.buildDelay);
            } catch (err) {
                log(`Failed to remove scaffolding at ${pos}: ${err.message}`);
            }
        }
    }
    state.scaffoldingBlocks = []; // Clear the list
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

        // Sort blocks by Y-coordinate to build from bottom up
        blocks.sort((a, b) => a.pos.value[1] - b.pos.value[1]);

        const minSchematicY = blocks[0].pos.value[1];
        const maxSchematicY = blocks[blocks.length - 1].pos.value[1];

        for (let currentLayerY = minSchematicY; currentLayerY <= maxSchematicY; currentLayerY += CONFIG.layerHeight) {
            if (!state.isBuilding) {
                log('Building stopped by command.');
                break; // Break outer loop if stop command is issued
            }

            const nextLayerY = currentLayerY + CONFIG.layerHeight;
            log(`Preparing for layers Y: ${currentLayerY} to ${nextLayerY - 1}`);

            let needsMoreItemsForLayer = true; // Flag to control re-attempting layer
            let retryCount = 0;
            const MAX_LAYER_RETRIES = 5; // Prevent infinite loops if items are truly unavailable

            while (needsMoreItemsForLayer && retryCount < MAX_LAYER_RETRIES) {
                needsMoreItemsForLayer = false; // Assume success for this attempt
                retryCount++;

                // Calculate items needed for the current set of layers
                const itemsForCurrentLayers = calculateItemsForLayers(currentLayerY, nextLayerY);
                
                // Go to chest and manage inventory for these layers
                const inventoryReady = await manageInventory(state.chestPos, itemsForCurrentLayers);
                if (!inventoryReady) {
                    log(`Failed to get required items for layers Y: ${currentLayerY} to ${nextLayerY - 1}. Retrying (${retryCount}/${MAX_LAYER_RETRIES})...`);
                    needsMoreItemsForLayer = true; // Need to retry
                    await sleep(5000); // Wait before next attempt
                    continue; // Continue while loop to retry inventory
                }
                scanInventory(); // Rescan after inventory management

                // Filter blocks for the current layers
                const blocksInCurrentLayers = blocks.filter(block =>
                    block.pos.value[1] >= currentLayerY && block.pos.value[1] < nextLayerY
                );

                for (const block of blocksInCurrentLayers) {
                    if (!state.isBuilding) break; // If stop command issued, break all loops

                    const blockState = palette[block.state.value];
                    const blockName = getBlockName(blockState);
                    const position = new Vec3(
                        block.pos.value[0] + state.buildPos.x,
                        block.pos.value[1] + state.buildPos.y,
                        block.pos.value[2] + state.buildPos.z
                    );

                    // Check if the block already exists and is correct
                    const existingBlock = bot.blockAt(position);
                    if (existingBlock && existingBlock.name === blockName) {
                        continue; // Skip if already placed
                    }
                    
                    // Ensure bot has the item
                    const item = bot.inventory.items().find(i => i.name === blockName);
                    if (!item) {
                        log(`Out of ${blockName} for ${position}. Need to get more items for this layer. Restarting layer process.`);
                        needsMoreItemsForLayer = true; // Set flag to retry this layer
                        break; // Break inner block loop to go to outer while loop
                    }

                    // Go to position and place scaffolding if needed
                    await goToPosition(position, 4); // Go generally near the target
                    const scaffoldingNeeded = await placeScaffolding(position);
                    if (!scaffoldingNeeded) {
                        log(`Could not place scaffolding for ${position}. Skipping block.`);
                        continue; // Skip this block, but continue with the layer
                    }

                    try {
                        await bot.equip(item, 'hand');
                        
                        // Find a reference block to place on
                        let referenceBlock = bot.blockAt(position.offset(0, -1, 0)); // Try directly below
                        if (!referenceBlock || referenceBlock.name === 'air') {
                            // If no block directly below, try adjacent blocks on the same Y-level
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
                            continue;
                        }

                        // Calculate face to place on (usually top of reference block)
                        const faceVector = position.minus(referenceBlock.position);

                        await bot.placeBlock(referenceBlock, faceVector);
                        log(`Placed ${blockName} at ${position.x}, ${position.y}, ${position.z}`);
                        await sleep(CONFIG.buildDelay);
                    } catch (err) {
                        log(`Building error at ${position}: ${err.message}`);
                        // Consider retrying or skipping this block
                    } finally {
                        // Always try to remove scaffolding after placing the block
                        await removeScaffolding();
                    }
                } // End of blocksInCurrentLayers loop

                if (needsMoreItemsForLayer) {
                    // If we broke out of the inner loop due to missing items,
                    // the while loop will re-run for the same layer.
                    log(`Re-attempting layer Y: ${currentLayerY} due to missing items.`);
                } else {
                    // If we completed the inner loop without needing more items,
                    // then this layer is done, and the while loop can exit.
                    log(`Completed layer Y: ${currentLayerY} to ${nextLayerY - 1}.`);
                }
            } // End of while (needsMoreItemsForLayer) loop

            if (retryCount >= MAX_LAYER_RETRIES && needsMoreItemsForLayer) {
                log(`Max retries (${MAX_LAYER_RETRIES}) reached for layers Y: ${currentLayerY} to ${nextLayerY - 1}. Cannot complete this section due to persistent missing items.`);
                break; // Break the outer for loop if max retries reached
            }
        } // End of currentLayerY loop

        log('Build complete ✅');
    } catch (err) {
        log(`Build failed: ${err.message}`);
    } finally {
        state.isBuilding = false;
        await removeScaffolding(); // Ensure all scaffolding is removed at the end
    }
};

// Event handlers
bot.once('spawn', async () => {
    log('Bot spawned!');
    await downloadSchematic();
});

const handleCommand = async (username, message) => {
    if (username === bot.username) return; // Ignore bot's own messages

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
                // This command can now trigger a full inventory check and request
                log('Checking materials and managing inventory...');
                const allRequired = calculateItemsForLayers(0, state.structure.size.value[1]); // Get all items
                await manageInventory(state.chestPos, allRequired);
                scanInventory();
                state.missingItems = {};
                for (const [name, needed] of Object.entries(allRequired)) {
                    const have = state.inventoryItems[name] || 0;
                    if (have < needed) {
                        state.missingItems[name] = needed - have;
                    }
                }
                if (Object.keys(state.missingItems).length > 0) {
                    log('Still missing items (use /give @s <item> <amount>):');
                    for (const [item, amount] of Object.entries(state.missingItems)) {
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

// Collect nearby items periodically (when not building or already collecting)
setInterval(async () => {
    if (!state.isBuilding && !state.isCollecting) {
        await collectNearbyItems();
    }
}, 30000); // Every 30 seconds

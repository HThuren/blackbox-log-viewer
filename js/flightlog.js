"use strict";

/**
 * Uses a FlightLogParser to provide on-demand parsing (and caching) a flight data log. An index is computed
 * to allow efficient seeking.
 */
function FlightLog(logData) {
    var
        ADDITIONAL_COMPUTED_FIELD_COUNT = 3,
    
        that = this,
        logIndex = false,
        logIndexes = new FlightLogIndex(logData),
        parser = new FlightLogParser(logData),
        
        iframeDirectory,
        
        // We cache these details so they don't have to be recomputed on every request:
        numCells = false, numMotors = false,
        
        fieldNames = [],
        fieldNameToIndex = {},

        chunkCache = new FIFOCache(2),
        
        fieldSmoothing = [],
        maxSmoothing = 0,
        
        smoothedCache = new FIFOCache(2);
    
    //Public fields:
    this.parser = parser;
    
    this.getMainFieldCount = function() {
        return fieldNames.length;
    };
    
    this.getMainFieldNames = function() {
        return fieldNames;
    };
    
    /**
     * Get the parse error encountered when reading the log with the given index, or false if no error
     * was encountered.
     */
    this.getLogError = function(logIndex) {
        var
            error = logIndexes.getIntraframeDirectory(logIndex).error;
        
        if (error)
            return error;
        
        return false;
    };
    
    /**
     * Get the earliest time seen in the log of the given index, or leave off the logIndex
     * argument to fetch details for the current log.
     */
    this.getMinTime = function(logIndex) {
        if (logIndex === undefined) {
            return iframeDirectory.minTime;
        } else {
            return logIndexes.getIntraframeDirectory(logIndex).minTime;
        }
    };
    
    /**
     * Get the latest time seen in the log of the given index, or leave off the logIndex
     * argument to fetch details for the current log.
     */
    this.getMaxTime = function(logIndex) {
        if (logIndex === undefined) {
            return iframeDirectory.maxTime;
        } else {
            return logIndexes.getIntraframeDirectory(logIndex).maxTime;
        }
    };
    
    /**
     * Get the flight controller system information that was parsed for the current log file.
     */
    this.getSysConfig = function() {
        return parser.sysConfig;
    };
    
    /**
     * Get the index of the currently selected log.
     */
    this.getLogIndex = function() {
        return logIndex;
    }
    
    this.getLogCount = function() {
        return logIndexes.getLogCount();
    };
    
    /**
     * Return a coarse summary of throttle position and events across the entire log.
     */
    this.getActivitySummary = function() {
        var directory = logIndexes.getIntraframeDirectory(logIndex);
        
        return {
            times: directory.times,
            avgThrottle: directory.avgThrottle,
            hasEvent: directory.hasEvent
        };
    };
    
    /**
     * Get the index of the field with the given name, or undefined if that field doesn't exist in the log.
     */
    this.getMainFieldIndexByName = function(name) {
        return fieldNameToIndex[name];
    };

    this.getMainFieldIndexes = function(name) {
        return fieldNameToIndex;
    };

    this.getFrameAtTime = function(startTime) {
        var
            chunks = this.getChunksInTimeRange(startTime, startTime),
            chunk = chunks[0];
        
        if (chunk) {
            for (var i = 0; i < chunk.frames.length; i++) {
                if (chunk.frames[i][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME] > startTime)
                    break;
            }
            
            return chunk.frames[i - 1];
        } else
            return false;
    };
    
    this.getSmoothedFrameAtTime = function(startTime) {
        var
            chunks = this.getSmoothedChunksInTimeRange(startTime, startTime),
            chunk = chunks[0];
        
        if (chunk) {
            for (var i = 0; i < chunk.frames.length; i++) {
                if (chunk.frames[i][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME] > startTime)
                    break;
            }
            
            return chunk.frames[i - 1];
        } else
            return false;
    };
    
    function buildFieldNames() {
        var 
            i;
        
        // Make an independent copy
        fieldNames = parser.mainFieldNames.slice(0);
        
        fieldNames.push("heading[0]", "heading[1]", "heading[2]");
        
        fieldNameToIndex = {};
        for (i = 0; i < fieldNames.length; i++) {
            fieldNameToIndex[fieldNames[i]] = i;
        }
    }
    
    function estimateNumMotors() {
        var count = 0;
        
        for (var j = 0; j < 8; j++) {
            if (that.getMainFieldIndexByName("motor[" + j + "]") !== undefined) {
                count++;
            }
        }
        
        numMotors = count;
    }
    
    function estimateNumCells() {
        var 
            i, 
            fieldNames = that.getMainFieldNames(),
            sysConfig = that.getSysConfig(),
            refVoltage = that.vbatADCToMillivolts(sysConfig.vbatref) / 100,
            found = false;

        //Are we even logging VBAT?
        if (!fieldNameToIndex['vbatLatest']) {
            numCells = false;
        } else {
            for (i = 1; i < 8; i++) {
                if (refVoltage < i * sysConfig.vbatmaxcellvoltage)
                    break;
            }
    
            numCells = i;
        }
    };
    
    this.getNumCellsEstimate = function() {
        return numCells;
    };
    
    this.getNumMotors = function() {
        return numMotors;
    };
    
    /**
     * Get the raw chunks in the range [startIndex...endIndex] (inclusive)
     * 
     * When the cache misses, this will result in parsing the original log file to create chunks.
     */
    function getChunksInIndexRange(startIndex, endIndex) {
        var 
            resultChunks = [],
            eventNeedsTimestamp = [];
        
        if (startIndex < 0)
            startIndex = 0;

        if (endIndex > iframeDirectory.offsets.length - 1)
            endIndex = iframeDirectory.offsets.length - 1;
        
        if (endIndex < startIndex)
            return [];
        
        //Assume caller asked for about a screen-full. Try to cache about three screens worth.
        if (chunkCache.capacity < (endIndex - startIndex + 1) * 3 + 1) {
            chunkCache.capacity = (endIndex - startIndex + 1) * 3 + 1;
            
            //And while we're here, use the same size for the smoothed cache
            smoothedCache.capacity = chunkCache.capacity;
        }
        
        for (var chunkIndex = startIndex; chunkIndex <= endIndex; chunkIndex++) {
            var 
                chunkStartOffset, chunkEndOffset,
                chunk = chunkCache.get(chunkIndex);
            
            // Did we cache this chunk already?
            if (chunk) {
                // Use the first event in the chunk to fill in event times at the trailing end of the previous one
                var frame = chunk.frames[0];
                
                for (var i = 0; i < eventNeedsTimestamp.length; i++) {
                    eventNeedsTimestamp[i].time = frame[FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME];
                }
                eventNeedsTimestamp.length = 0;
            } else {
                // Parse the log file to create this chunk since it wasn't cached
                chunkStartOffset = iframeDirectory.offsets[chunkIndex];
                
                if (chunkIndex + 1 < iframeDirectory.offsets.length)
                    chunkEndOffset = iframeDirectory.offsets[chunkIndex + 1];
                else // We're at the end so parse till end-of-log
                    chunkEndOffset = logIndexes.getLogBeginOffset(logIndex + 1);

                chunk = chunkCache.recycle();
                
                // Were we able to reuse memory from an expired chunk?
                if (chunk) {
                    chunk.index = chunkIndex;
                    /* 
                     * getSmoothedChunks would like to share this data, so we can't reuse the old arrays without
                     * accidentally changing data that it might still want to reference:
                     */
                    chunk.gapStartsHere = {};
                    chunk.events = [];
                    delete chunk.needsEventTimes;
                    
                    //But reuse the old chunk's frames array since getSmoothedChunks has an independent copy
                } else {
                    chunk = {
                        index: chunkIndex,
                        frames: [],
                        gapStartsHere: {},
                        events: []
                    };
                }
                
                chunk.initialIMU = iframeDirectory.initialIMU[chunkIndex];
                
                var
                    mainFrameIndex = 0;
                
                parser.onFrameReady = function(frameValid, frame, frameType, frameOffset, frameSize) {
                    if (frameValid) {
                        if (frameType == 'P' || frameType == 'I') {
                            //The parser re-uses the "frame" array so we must copy that data somewhere else
                            
                            //Do we have a recycled chunk to copy on top of?
                            if (chunk.frames[mainFrameIndex]) {
                                chunk.frames[mainFrameIndex].length = frame.length;
                                
                                for (var i = 0; i < frame.length; i++) {
                                    chunk.frames[mainFrameIndex][i] = frame[i];
                                }
                            } else {
                                //Otherwise allocate a new copy of it
                                chunk.frames.push(frame.slice(0)); 
                            }
                            
                            for (var i = 0; i < eventNeedsTimestamp.length; i++) {
                                eventNeedsTimestamp[i].time = frame[FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME];
                            }
                            eventNeedsTimestamp.length = 0;
                            
                            mainFrameIndex++;
                        } else if (frameType == 'E') {
                            /* 
                             * If the event was logged during a loop iteration, it will appear in the log
                             * before that loop iteration does (since the main log stream is logged at the very
                             * end of the loop). 
                             * 
                             * So we want to use the timestamp of that later frame as the timestamp of the loop 
                             * iteration this event was logged in.
                             */
                            if (!frame.time) {
                                eventNeedsTimestamp.push(frame);
                            }
                            chunk.events.push(frame);
                        }
                    } else {
                        chunk.gapStartsHere[mainFrameIndex - 1] = true;
                    }
                };

                parser.parseLogData(false, chunkStartOffset, chunkEndOffset);
                
                //Truncate the array to fit just in case it was recycled and the new one is shorter
                chunk.frames.length = mainFrameIndex;
                
                chunkCache.add(chunkIndex, chunk);
            }
            
            resultChunks.push(chunk);
        }
        
        /* 
         * If there is an event that trailed the all the chunks we were decoding, we can't give it an event time field 
         * because we didn't get to see the time of the next frame.
         */
        if (eventNeedsTimestamp.length > 0) {
            resultChunks[resultChunks.length - 1].needsEventTimes = true;
        }
        
        return resultChunks;
    }
    
    /**
     * Get an array of chunks which span times from the given start to end time.
     * Each chunk is an array of log frames.
     */
    this.getChunksInTimeRange = function(startTime, endTime) {
        var 
            startIndex = binarySearchOrPrevious(iframeDirectory.times, startTime),
            endIndex = binarySearchOrPrevious(iframeDirectory.times, endTime);
        
        return getChunksInIndexRange(startIndex, endIndex);
    };
    
    /* 
     * Smoothing is an array of {field:1, radius:100000} where radius is in us. You only need to specify fields
     * which need to be smoothed.
     */
    this.setFieldSmoothing = function(newSmoothing) {
        smoothedCache.clear();
        fieldSmoothing = newSmoothing;
        
        maxSmoothing = 0;
        
        for (var i = 0; i < newSmoothing.length; i++) {
            if (newSmoothing[i].radius > maxSmoothing) {
                maxSmoothing = newSmoothing[i].radius;
            }
        }
    };
    
    /**
     * Use the data in sourceChunks to compute additional fields (like IMU attitude) and add those into the 
     * resultChunks. 
     * 
     * The idea is that sourceChunks will be unsmoothed original data for reference and resultChunks
     * will be smoothed chunks to add data on to.
     */
    function injectComputedFields(sourceChunks, destChunks) {
        var
            gyroData = [fieldNameToIndex["gyroData[0]"], fieldNameToIndex["gyroData[1]"], fieldNameToIndex["gyroData[2]"]], 
            accSmooth = [fieldNameToIndex["accSmooth[0]"], fieldNameToIndex["accSmooth[1]"], fieldNameToIndex["accSmooth[2]"]],
            magADC = [fieldNameToIndex["magADC[0]"], fieldNameToIndex["magADC[1]"], fieldNameToIndex["magADC[2]"]],
            
            sourceChunkIndex, destChunkIndex,
            
            sysConfig,
            attitude;
        
        if (destChunks.length == 0) {
            return;
        }
        
        // Do we have mag fields? If not mark that data as absent
        if (!magADC[0]) {
            magADC = false;
        }
        
        sysConfig = that.getSysConfig();
        
        sourceChunkIndex = 0;
        destChunkIndex = 0;
        
        // Skip leading source chunks
        while (sourceChunks[sourceChunkIndex].index < destChunks[destChunkIndex].index) {
            sourceChunkIndex++;
        }
        
        for (; destChunkIndex < destChunks.length; sourceChunkIndex++, destChunkIndex++) {
            var 
                destChunk = destChunks[destChunkIndex],
                sourceChunk = sourceChunks[sourceChunkIndex];

            if (!destChunk.hasAdditionalFields) {
                destChunk.hasAdditionalFields = true;
    
                var 
                    chunkIMU = new IMU(sourceChunks[sourceChunkIndex].initialIMU);
                
                for (var i = 0; i < sourceChunk.frames.length; i++) {
                    var 
                        srcFrame = sourceChunk.frames[i],
                        destFrame = destChunk.frames[i];
                    
                    attitude = chunkIMU.updateEstimatedAttitude(
                        [srcFrame[gyroData[0]], srcFrame[gyroData[1]], srcFrame[gyroData[2]]],
                        [srcFrame[accSmooth[0]], srcFrame[accSmooth[1]], srcFrame[accSmooth[2]]],
                        srcFrame[FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME], 
                        sysConfig.acc_1G, 
                        sysConfig.gyroScale, 
                        magADC ? [srcFrame[magADC[0]], srcFrame[magADC[1]], srcFrame[magADC[2]]] : false);
                    
                    destFrame[destFrame.length - 3] = attitude.roll;
                    destFrame[destFrame.length - 2] = attitude.pitch;
                    destFrame[destFrame.length - 1] = attitude.heading;
                }
            }
        }
    };
    
    /**
     * Add timestamps to events that getChunksInRange was unable to compute, because at the time it had trailing
     * events in its chunk array but no next-chunk to take the times from for those events.
     * 
     * Set processLastChunk to true if the last chunk of this array is the final chunk in the file.
     */
    function addMissingEventTimes(chunks, processLastChunk) {
        /* 
         * If we're at the end of the file then we will compute event times for the last chunk, otherwise we'll
         * wait until we have the next chunk to fill in times for this last chunk.
         */
        var 
            endChunk = processLastChunk ? chunks.length : chunks.length - 1; 
        
        for (var i = 0; i < endChunk; i++) {
            var chunk = chunks[i];
            
            if (chunk.needsEventTimes) {
                // What is the time of the next frame after the chunk with the trailing events? We'll use that for the event times
                var nextTime;
                
                if (i + 1 < chunks.length) {
                    var nextChunk = chunks[i + 1];
                    
                    nextTime = nextChunk.frames[0][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME];
                } else {
                    //Otherwise we're at the end of the log so assume this event was logged sometime after the final frame
                    nextTime = chunk.frames[chunk.frames.length - 1][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME];
                }
                
                for (var j = chunk.events.length - 1; j >= 0; j--) {
                    if (chunk.events[j].time === undefined)  {
                        chunk.events[j].time = nextTime;
                    } else {
                        // All events with missing timestamps should appear at the end of the chunk, so we're done
                        break;
                    }
                }
                
                delete chunk.needsEventTimes;
            }
        }
    }
    
    /*
     * Double check that the indexes of each chunk in the array are in increasing order (bugcheck).
     */
    function verifyChunkIndexes(chunks) {
        // Uncomment for debugging...
        /* 
        for (var i = 0; i < chunks.length - 1; i++) {
            if (chunks[i].index + 1 != chunks[i+1].index) {
                console.log("Bad chunk index, bug in chunk caching");
            }
        }*/
    }
    
    /**
     * Get an array of chunk data which has been smoothed by the previously-configured smoothing settings. The frames
     * in the chunks will at least span the range given by [startTime...endTime].
     */
    this.getSmoothedChunksInTimeRange = function(startTime, endTime) {
        var 
            sourceChunks,
            resultChunks, resultChunk,
            chunkAlreadyDone, allDone,
            timeFieldIndex = FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME;
        
        //if (maxSmoothing == 0) // TODO We can't bail early because we do things like add fields to the chunks at the end
        //    return this.getChunksInTimeRange(startTime, endTime);
        
        var
            /* 
             * Ensure that the range that the caller asked for can be fully smoothed by expanding the request 
             * for source chunks on either side of the range asked for (to smooth the chunks on the edges, we
             * need to be able to see their neighbors)
             */
            leadingROChunks = 1, trailingROChunks = 1,
            
            startIndex = binarySearchOrPrevious(iframeDirectory.times, startTime - maxSmoothing) - leadingROChunks,
            endIndex = binarySearchOrNext(iframeDirectory.times, endTime + maxSmoothing) + trailingROChunks;
        
        /* 
         * If our expanded source chunk range exceeds the actual source chunks available, trim down our leadingROChunks
         * and trailingROChunks to match (i.e. we are allowed to smooth the first and last chunks of the file despite
         * there not being a chunk past them to smooth against on one side).
         */
        if (startIndex < 0) {
            leadingROChunks += startIndex;
            startIndex = 0;
        }
        
        if (endIndex > iframeDirectory.offsets.length - 1) {
            trailingROChunks -= endIndex - (iframeDirectory.offsets.length - 1);
            endIndex = iframeDirectory.offsets.length - 1;
        }
        
        sourceChunks = getChunksInIndexRange(startIndex, endIndex);

        verifyChunkIndexes(sourceChunks);

        //Create an independent copy of the raw frame data to smooth out:
        resultChunks = new Array(sourceChunks.length - leadingROChunks - trailingROChunks);
        chunkAlreadyDone = new Array(sourceChunks.length);
        
        allDone = true;
        
        //Don't smooth the edge chunks since they can't be fully smoothed
        for (var i = leadingROChunks; i < sourceChunks.length - trailingROChunks; i++) {
            var 
                sourceChunk = sourceChunks[i],
                resultChunk = smoothedCache.get(sourceChunk.index);
            
            chunkAlreadyDone[i] = resultChunk ? true : false;
            
            //If we haven't already smoothed this chunk
            if (!chunkAlreadyDone[i]) {
                allDone = false;
                
                resultChunk = smoothedCache.recycle();
                
                if (resultChunk) {
                    //Reuse the memory from the expired chunk to reduce garbage
                    resultChunk.index = sourceChunk.index;
                    resultChunk.frames.length = sourceChunk.frames.length;
                    resultChunk.gapStartsHere = sourceChunk.gapStartsHere;
                    resultChunk.events = sourceChunk.events;
                    resultChunk.hasAdditionalFields = false;
                    
                    //Copy frames onto the expired chunk:
                    for (var j = 0; j < resultChunk.frames.length; j++) {
                        if (resultChunk.frames[j]) {
                            //Copy on top of the recycled array:
                            resultChunk.frames[j].length = sourceChunk.frames[j].length + ADDITIONAL_COMPUTED_FIELD_COUNT;
                            
                            for (var k = 0; k < sourceChunk.frames[j].length; k++) {
                                resultChunk.frames[j][k] = sourceChunk.frames[j][k];
                            }
                        } else {
                            //Allocate a new copy of the raw array:
                            resultChunk.frames[j] = sourceChunk.frames[j].slice(0);
                            resultChunk.frames[j].length += ADDITIONAL_COMPUTED_FIELD_COUNT;
                        }
                    }
                } else {
                    //Allocate a new chunk
                    resultChunk = {
                        index: sourceChunk.index,
                        frames: new Array(sourceChunk.frames.length),
                        gapStartsHere: sourceChunk.gapStartsHere,
                        events: sourceChunk.events
                    };
                    
                    for (var j = 0; j < resultChunk.frames.length; j++) {
                        resultChunk.frames[j] = sourceChunk.frames[j].slice(0);
                        resultChunk.frames[j].length += ADDITIONAL_COMPUTED_FIELD_COUNT;
                    }
                }
                
                smoothedCache.add(resultChunk.index, resultChunk);
            }
            
            resultChunks[i - leadingROChunks] = resultChunk;
        }

        if (!allDone) {
            for (var i = 0; i < fieldSmoothing.length; i++) {
                var 
                    radius = fieldSmoothing[i].radius,
                    fieldIndex = fieldSmoothing[i].field,
                    
                    //The position we're currently computing the smoothed value for:
                    centerChunkIndex, centerFrameIndex;
                    
                //The outer two loops are used to begin a new partition to smooth within
                mainLoop:
                
                // Don't bother to smooth the first and last source chunks, since we can't smooth them completely
                for (centerChunkIndex = leadingROChunks; centerChunkIndex < sourceChunks.length - trailingROChunks; centerChunkIndex++) {
                    if (chunkAlreadyDone[centerChunkIndex])
                        continue;
                    
                    for (centerFrameIndex = 0; centerFrameIndex < sourceChunks[centerChunkIndex].frames.length; ) {
                        var
                            //Current beginning & end of the smoothing window:
                            leftChunkIndex = centerChunkIndex,
                            leftFrameIndex = centerFrameIndex,
                        
                            rightChunkIndex, rightFrameIndex,
    
                            /* 
                             * The end of the current partition to be smoothed (exclusive, so the partition doesn't 
                             * contain the value pointed to by chunks[endChunkIndex][endFrameIndex]).
                             * 
                             * We'll refine this guess for the end of the partition later if we find discontinuities:
                             */
                            endChunkIndex = sourceChunks.length - 1 - trailingROChunks,
                            endFrameIndex = sourceChunks[endChunkIndex].frames.length,
        
                            partitionEnded = false,
                            accumulator = 0,
                            valuesInHistory = 0,
                             
                            centerTime = sourceChunks[centerChunkIndex].frames[centerFrameIndex][timeFieldIndex];
        
                        /* 
                         * This may not be the left edge of a partition, we may just have skipped the previous chunk due to
                         * it having already been cached. If so, we can read the values from the previous chunk in order
                         * to prime our history window. Move the left&right indexes to the left so the main loop will read
                         * those earlier values.
                         */
                        while (leftFrameIndex > 0 || leftFrameIndex == 0 && leftChunkIndex > 0) {
                            var
                                oldleftChunkIndex = leftChunkIndex,
                                oldleftFrameIndex = leftFrameIndex;
                            
                            //Try moving it left
                            if (leftFrameIndex == 0) {
                                leftChunkIndex--;
                                leftFrameIndex = sourceChunks[leftChunkIndex].frames.length - 1;
                            } else {
                                leftFrameIndex--;
                            }
                            
                            if (sourceChunks[leftChunkIndex].gapStartsHere[leftFrameIndex] || sourceChunks[leftChunkIndex].frames[leftFrameIndex][timeFieldIndex] < centerTime - radius) {
                                //We moved the left index one step too far, shift it back
                                leftChunkIndex = oldleftChunkIndex;
                                leftFrameIndex = oldleftFrameIndex;
                                
                                break;
                            }
                        }
                        
                        rightChunkIndex = leftChunkIndex;
                        rightFrameIndex = leftFrameIndex;
                        
                        //The main loop, where we march our smoothing window along until we exhaust this partition
                        while (centerChunkIndex < endChunkIndex || centerChunkIndex == endChunkIndex && centerFrameIndex < endFrameIndex) {
                            // Old values fall out of the window
                            while (sourceChunks[leftChunkIndex].frames[leftFrameIndex][timeFieldIndex] < centerTime - radius) {
                                accumulator -= sourceChunks[leftChunkIndex].frames[leftFrameIndex][fieldIndex];
                                valuesInHistory--;
                                
                                leftFrameIndex++;
                                if (leftFrameIndex == sourceChunks[leftChunkIndex].frames.length) {
                                    leftFrameIndex = 0;
                                    leftChunkIndex++;
                                }
                            }
        
                            //New values are added to the window
                            while (!partitionEnded && sourceChunks[rightChunkIndex].frames[rightFrameIndex][timeFieldIndex] <= centerTime + radius) {
                                accumulator += sourceChunks[rightChunkIndex].frames[rightFrameIndex][fieldIndex];
                                valuesInHistory++;
        
                                //If there is a discontinuity after this point, stop trying to add further values
                                if (sourceChunks[rightChunkIndex].gapStartsHere[rightFrameIndex]) {
                                    partitionEnded = true;
                                }
                                    
                                //Advance the right index onward since we read a value
                                rightFrameIndex++;
                                if (rightFrameIndex == sourceChunks[rightChunkIndex].frames.length) {
                                    rightFrameIndex = 0;
                                    rightChunkIndex++;
                                    
                                    if (rightChunkIndex == sourceChunks.length) {
                                        //We reached the end of the region of interest!
                                        partitionEnded = true;
                                    }
                                }
    
                                if (partitionEnded) {
                                    //Let the center-storing loop know not to advance the center to this position: 
                                    endChunkIndex = rightChunkIndex;
                                    endFrameIndex = rightFrameIndex;
                                }
                            }
        
                            // Store the average of the history window into the frame in the center of the window
                            resultChunks[centerChunkIndex - leadingROChunks].frames[centerFrameIndex][fieldIndex] = Math.round(accumulator / valuesInHistory);
                            
                            // Advance the center so we can start computing the next value
                            centerFrameIndex++;
                            if (centerFrameIndex == sourceChunks[centerChunkIndex].frames.length) {
                                centerFrameIndex = 0;
                                centerChunkIndex++;
    
                                //Is the next chunk already cached? Then we have nothing to write into there
                                if (chunkAlreadyDone[centerChunkIndex])
                                    continue mainLoop;
                                
                                //Have we covered the whole ROI?
                                if (centerChunkIndex == sourceChunks.length - trailingROChunks)
                                    break mainLoop;
                            }
                            
                            centerTime = sourceChunks[centerChunkIndex].frames[centerFrameIndex][timeFieldIndex];
                        }
                    }
                }
            }
        }
        
        addMissingEventTimes(sourceChunks, trailingROChunks == 0);
        injectComputedFields(sourceChunks, resultChunks);
        
        verifyChunkIndexes(sourceChunks);
        verifyChunkIndexes(resultChunks);
        
        return resultChunks;
    };
    
    this.openLog = function(index) {
        logIndex = index;
        
        chunkCache.clear();
        smoothedCache.clear();
        
        iframeDirectory = logIndexes.getIntraframeDirectory(index);
        
        parser.parseHeader(logIndexes.getLogBeginOffset(index), logIndexes.getLogBeginOffset(index + 1));
        
        buildFieldNames();
        
        estimateNumMotors();
        estimateNumCells();
    };
}

FlightLog.prototype.accRawToGs = function(value) {
    return value / this.getSysConfig().acc_1G;
};

FlightLog.prototype.gyroRawToDegreesPerSecond = function(value) {
    return this.getSysConfig().gyroScale * 1000000 / (Math.PI / 180.0) * value;
};

FlightLog.prototype.getReferenceVoltageMillivolts = function() {
    return this.vbatADCToMillivolts(this.getSysConfig().vbatref);
};

FlightLog.prototype.vbatADCToMillivolts = function(vbatADC) {
    var
        ADCVREF = 33;
    
    // ADC is 12 bit (i.e. max 0xFFF), voltage reference is 3.3V, vbatscale is premultiplied by 100
    return (vbatADC * ADCVREF * 10 * this.getSysConfig().vbatscale) / 0xFFF;
};

FlightLog.prototype.amperageADCToMillivolts = function(amperageADC) {
    var
        ADCVREF = 33,
        millivolts = (amperageADC * ADCVREF * 100) / 4095;
    
    millivolts -= this.getSysConfig().currentMeterOffset;

    return millivolts * 10000 / this.getSysConfig().currentMeterScale;
};
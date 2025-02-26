--[[
  Check if this job has a parent. If so we will just remove it from
  the parent child list, but if it is the last child we should move the parent to "wait/paused"
  which requires code from "moveToFinished"
]]

--- @include "destructureJobKey"

local function moveParentToWait(parentPrefix, parentId, emitEvent)
  if rcall("HEXISTS", parentPrefix .. "meta", "paused") ~= 1 then
    rcall("RPUSH", parentPrefix .. "wait", parentId)
  else
    rcall("RPUSH", parentPrefix .. "paused", parentId)
  end

  if emitEvent then
    local parentEventStream = parentPrefix .. "events"
    rcall("XADD", parentEventStream, "*", "event", "active", "jobId", parentId, "prev", "waiting-children")
  end
end

local function removeParentDependencyKey(jobKey, hard, parentKey, baseKey)
  if parentKey then
    local parentProcessedKey = parentKey .. ":processed"
    rcall("HDEL", parentProcessedKey, jobKey)
    local parentDependenciesKey = parentKey .. ":dependencies"
    local result = rcall("SREM", parentDependenciesKey, jobKey)
    if result > 0 then
      local pendingDependencies = rcall("SCARD", parentDependenciesKey)
      if pendingDependencies == 0 then
        local parentId = getJobIdFromKey(parentKey)
        local parentPrefix = getJobKeyPrefix(parentKey, parentId)

        rcall("ZREM", parentPrefix .. "waiting-children", parentId)

        if hard then  
          if parentPrefix == baseKey then
            removeParentDependencyKey(parentKey, hard, nil, baseKey)
            rcall("DEL", parentKey, parentKey .. ':logs',
              parentKey .. ':dependencies', parentKey .. ':processed')
          else
            moveParentToWait(parentPrefix, parentId)
          end
        else
          moveParentToWait(parentPrefix, parentId, true)
        end
      end
    end
  else
    local missedParentKey = rcall("HGET", jobKey, "parentKey")
    if( (type(missedParentKey) == "string") and missedParentKey ~= "" and (rcall("EXISTS", missedParentKey) == 1)) then
      local parentProcessedKey = missedParentKey .. ":processed"
      rcall("HDEL", parentProcessedKey, jobKey)
      local parentDependenciesKey = missedParentKey .. ":dependencies"
      local result = rcall("SREM", parentDependenciesKey, jobKey)
      if result > 0 then
        local pendingDependencies = rcall("SCARD", parentDependenciesKey)
        if pendingDependencies == 0 then
          local parentId = getJobIdFromKey(missedParentKey)
          local parentPrefix = getJobKeyPrefix(missedParentKey, parentId)

          rcall("ZREM", parentPrefix .. "waiting-children", parentId)

          if hard then  
            if parentPrefix == baseKey then
              removeParentDependencyKey(missedParentKey, hard, nil, baseKey)
              rcall("DEL", missedParentKey, missedParentKey .. ':logs',
                missedParentKey .. ':dependencies', missedParentKey .. ':processed')
            else
              moveParentToWait(parentPrefix, parentId)
            end
          else
            moveParentToWait(parentPrefix, parentId, true)
          end
        end
      end
    end  
  end
end

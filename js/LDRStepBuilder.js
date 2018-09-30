/*
The LDRStepBulder is used for displaying step-by-step building instructions.

An LDRStepBulder object represents one or more a placed parts (LDRPartDescription).

If more than one placed part, the color and ID are assumed to be the same as it represents a step where more than once submodel is placed onto a model. Only the first placed part is shown being built, while the rest are added in a "placement step". In this step all placed parts are place onto their parent model.

"current" is used to keep track of the currently shown step. If a model has X steps, then "current" can take the values:
- -1 to indicate that the model is not yet being being built (at the "pre step")
- 0 to X-1 to show the step at these positions
- X to show the placement step.

The builder supports the operations:
- nextStep: Single step forward (if possible)
- prevStep: Single step back (if possible)
- fastForward: Go to last step of currently-active model. Unless at placement-step, then do it for next model.
- fastReverse: Go to first step of currently-active model. Unless at placement-step, then do it for next model.
- moveSteps: Go forward/back a specific number of steps.
*/
var LDR = LDR || {};
LDR.changeBufferSize = 0;
LDR.changeBufferLimit = 5;

LDR.StepBuilder = function(ldrLoader, partDescs, onProgress, isForMainModel, onlyLoadFirstStep) {
    this.ldrLoader = ldrLoader;
    this.partDescs = partDescs;
    this.onProgress = onProgress;

    this.meshCollectors = []; // One for each step. null to represent non-built obejcts
    this.subBuilders = []; // One for each step. null to represent no step builder.
    this.current = -1; // �ndex of currently-shown step (call nextStep() to initialize)
    this.extraParts = partDescs.length > 1; // Replace with actual mesh builder once loaded.
    this.bounds = []; // Bounds for each step
    this.firstStepLoaded = true;
    
    var partDesc = partDescs[0];
    this.part = ldrLoader.ldrPartTypes[partDesc.ID];
    if(!this.part || this.part === true) {
	// Unloaded model. Stop immediately.
	this.firstStepLoaded = false;
	return;
    }

    this.totalNumberOfSteps = this.part.steps.length;
    for(var i = 0; i < this.part.steps.length; i++) {
	var step = this.part.steps[i];
	if(step.ldrs.length > 0) {
	    var subDescs = [];
	    for(var j = 0; j < step.ldrs.length; j++) {
		var placed = step.ldrs[j].placeAt(partDesc);
		subDescs.push(placed);
	    }
	    var subStepBuilder = new LDR.StepBuilder(ldrLoader, subDescs, false, onlyLoadFirstStep);
	    if(!subStepBuilder.firstStepLoaded) {
		this.firstStepLoaded = false;
		return; // Break early.
	    }
	    this.subBuilders.push(subStepBuilder);
	    this.totalNumberOfSteps += subStepBuilder.totalNumberOfSteps; 
	}
	else {
	    this.subBuilders.push(null);
	}
	this.meshCollectors.push(null);
	this.bounds.push(null);
	if(onlyLoadFirstStep)
	    break; // First step loaded
    }
    this.bounds.push(null); // One more for placement step.
    if(isForMainModel && partDescs.length > 1)
	this.totalNumberOfSteps++;
    //console.log("Builder for " + partDesc.ID + " with " + this.part.steps.length + " normal steps. Total: " + this.totalNumberOfSteps);
}

LDR.StepBuilder.prototype.computeCameraPositionRotation = function(defaultMatrix, currentRotationMatrix) {
    if(this.current == -1 || this.current == this.subBuilders.length)
	throw "Can't reposition in void for step " + this.current + " in " + this.part.ID;

    var subBuilder = this.subBuilders[this.current];
    if((subBuilder !== null) && !subBuilder.isAtPlacementStep()) {
	return subBuilder.computeCameraPositionRotation(defaultMatrix, currentRotationMatrix); // Delegate to subBuilder.
    }

    var stepRotation = this.part.steps[this.current].rotation;

    // Get the current model rotation matrix and model center:
    var pr = this.partDescs[0].rotation.elements;
    var modelCenter = new THREE.Vector3(); 
    this.bounds[this.current].getCenter(modelCenter);

    var partM4 = new THREE.Matrix4();
    partM4.set(pr[0], pr[3], pr[6], 0,
	       pr[1], pr[4], pr[7], 0,
	       pr[2], pr[5], pr[8], 0,
	       0,     0,     0,     1);
    var invM4 = new THREE.Matrix4();
    invM4.getInverse(partM4, true);

    var invY = new THREE.Matrix4();
    invY.set(1,0,0,0, 0,-1,0,0, 0,0,-1,0, 0,0,0,1);

    currentRotationMatrix = new THREE.Matrix4();
    currentRotationMatrix.set(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1);

    if(stepRotation !== null) {
	var rotationMatrix = stepRotation.getRotationMatrix(defaultMatrix, currentRotationMatrix);
	currentRotationMatrix.multiply(rotationMatrix);
    }

    currentRotationMatrix.multiply(invY);
    currentRotationMatrix.multiply(invM4);

    modelCenter.applyMatrix4(invM4);
    modelCenter.applyMatrix4(invY);
    if(rotationMatrix)
	modelCenter.applyMatrix4(rotationMatrix);

    modelCenter.negate();

    return [modelCenter, currentRotationMatrix];
}

/*
 Adds a step to the model. 

 If stepping into a sub model: 
  - Ghost everything earlier (show again once sub-model is done)
*/
LDR.StepBuilder.prototype.nextStep = function(baseObject, doNotEraseForSubModels) {
    if(this.isAtPlacementStep()) {
	return false; // Dont walk past placement step.
    }
    var subBuilder = this.current == -1 ? null : this.subBuilders[this.current];
    var meshCollector = this.current == -1 ? null : this.meshCollectors[this.current];
    var willStep = (subBuilder === null) || subBuilder.isAtPlacementStep();

    // Special case: Step to placement step.
    if((this.current === this.subBuilders.length-1) && willStep) { 
	this.updateMeshCollectors(baseObject, false); // Make whole subBuilder new (for placement):
	this.drawExtras(baseObject);
	LDR.changeBufferSize += 1;
	this.current++;
	return true;
    }

    // Step to next:
    if(willStep) {
	if(subBuilder)
	    subBuilder.updateMeshCollectors(baseObject, true); // Make previous step 'old'.
	else if(meshCollector)
	    meshCollector.draw(baseObject, true); // Make previous step 'old'.
	this.current++; // Point to next step.
	subBuilder = this.subBuilders[this.current];
    }

    // Build what is new:
    if(subBuilder === null) { // Only build DAT-parts:
	var meshCollector = this.meshCollectors[this.current];
	if(meshCollector === null) {
	    var pd = this.partDescs[0];
            meshCollector = new THREE.LDRMeshCollector();
	    var step = this.part.steps[this.current];
	    step.generateThreePart(this.ldrLoader, pd.colorID, pd.position, pd.rotation, false, meshCollector);
	    //baseObject.add(new THREE.Box3Helper(b, 0xffff00));

	    this.meshCollectors[this.current] = meshCollector;
	    meshCollector.draw(baseObject, false); // New part is not 'old'.
	    this.setCurrentBounds(meshCollector.boundingBox);
	}
	else {
	    meshCollector.draw(baseObject, false); // New part is not 'old'.
	    meshCollector.setVisible(true);
	}
	LDR.changeBufferSize += 1;
    }
    else { // LDR sub-models:
	if(subBuilder.current == -1) {
	    // We have just stepped into this sub-model: Set all previous steps to invisible (they are already marked as old):
	    if(!doNotEraseForSubModels)
		this.setVisibleUpTo(false, this.current);
	}
	subBuilder.nextStep(baseObject, doNotEraseForSubModels);
	if(subBuilder.isAtPlacementStep()) {
	    // Add bounds:
	    if(this.bounds[this.current] === null) {
		var b = subBuilder.bounds[subBuilder.subBuilders.length];
		this.setCurrentBounds(b);
	    }

	    if(!doNotEraseForSubModels)
		this.setVisibleUpTo(true, this.current); // Show the invisible steps again.
	}
    }
    return true;
}

/*
This function is for setting correct visibility after having stepped without updating visibilities:
*/
LDR.StepBuilder.prototype.cleanUpAfterWalking = function() {
    var subBuilder = this.current == -1 ? null : this.subBuilders[this.current];
    if(subBuilder) {
	subBuilder.cleanUpAfterWalking();
    }

    if(subBuilder && !subBuilder.isAtPlacementStep()) {
	// Currently showing a subBuilder not at its placement step: Clear everything else!
	for(var i = 0; i < this.subBuilders.length; i++) {
	    var t = this.meshCollectors[i];
	    if(t !== null && t.isVisible()) {
		t.setVisible(false);
	    }
	    var s = this.subBuilders[i];
	    if(s && i != this.current) {
		s.setVisible(false);
	    }
	}
	if(this.extraParts && this.extraParts.isMeshCollector) {
	    this.extraParts.setVisible(false);
	}
    }
    else {
	// Currently in a non-subBuilder step, or placement step: Clear all after this step:
	for(var i = 0; i < this.subBuilders.length; i++) {
	    var t = this.meshCollectors[i];
	    var v = i <= this.current; // Make everything up to current step visible.
	    if(t !== null && t.isVisible() !== v) {
		t.setVisible(v);
	    }
	    var s = this.subBuilders[i];
	    if(s) {
		s.setVisible(v);
	    }
	}
	if(this.extraParts && this.extraParts.isMeshCollector) {
	    this.extraParts.setVisible(this.isAtPlacementStep());
	}
    }
}

LDR.StepBuilder.prototype.getBounds = function() {
    var subBuilder = this.subBuilders[this.current];
    if(subBuilder && !subBuilder.isAtPlacementStep()) {
	var ret = subBuilder.getBounds();
	if(ret)
	    return ret;
    }
    return this.bounds[this.current];
}

LDR.StepBuilder.prototype.setCurrentBounds = function(b) {
    if(this.current === 0) {
	if(!b)
	    throw "Illegal state: Empty first step!";
	this.bounds[this.current] = new THREE.Box3(b.min, b.max);
	return;
    }

    var prevBounds = new THREE.Box3();
    prevBounds.copy(this.bounds[this.current-1]);
    this.bounds[this.current] = prevBounds;
    if(b) {
	this.bounds[this.current].expandByPoint(b.min);
	this.bounds[this.current].expandByPoint(b.max);
    }
}

LDR.StepBuilder.prototype.getMultiplierOfCurrentStep = function() {
    var subBuilder = this.subBuilders[this.current];
    var ret = this.partDescs.length;
    if(!subBuilder || subBuilder.isAtPlacementStep())
	return ret; // If a subBuilder is not active (or at placement step), then return the number of parts this subBuilder returns. 
    return ret * subBuilder.getMultiplierOfCurrentStep();
}

LDR.BackgroundColors = Array("ffffff", "FFFF88", "CCFFCC", "FFBB99", "99AAFF", "FF99FF", "D9FF99", "FFC299");
LDR.StepBuilder.prototype.getBackgroundColorOfCurrentStep = function() {
    var level = this.getLevelOfCurrentStep();
    return LDR.BackgroundColors[level%LDR.BackgroundColors.length];
}

LDR.StepBuilder.prototype.getLevelOfCurrentStep = function() {
    var subBuilder = this.subBuilders[this.current];
    if(!subBuilder || subBuilder.isAtPlacementStep())
	return 0;
    return 1+subBuilder.getLevelOfCurrentStep();
}

LDR.StepBuilder.prototype.drawExtras = function(baseObject) {
    if(!this.extraParts) { // No extra parts to draw:
	if(this.bounds[this.subBuilders.length] === null) {
	    var b = this.bounds[this.subBuilders.length-1];
	    this.bounds[this.subBuilders.length] = new THREE.Box3(b.min, b.max);
	}
	return; // Done.
    }

    if(this.extraParts === true) { // Not already loaded
	this.extraParts = new THREE.LDRMeshCollector();

	var prevBounds = new THREE.Box3();
	prevBounds.copy(this.bounds[this.subBuilders.length-1]);
	this.bounds[this.subBuilders.length] = prevBounds;

	for(var i = 1; i < this.partDescs.length; i++) {
	    var pd = this.partDescs[i];
	    this.part.generateThreePart(this.ldrLoader, pd.colorID, pd.position, pd.rotation, false, this.extraParts);
	}
	this.extraParts.draw(baseObject); // Maintain 'old' state, hence undefined as second argument.
	if(this.subBuilders.length >= 2) {
	    var b = this.extraParts.boundingBox;
	    this.bounds[this.subBuilders.length].expandByPoint(b.min);
	    this.bounds[this.subBuilders.length].expandByPoint(b.max);
	}
    }
    else {
	this.extraParts.setVisible(true);
    }
}

/*
 takes a step back in the building instructions (see nextStep()).
*/
LDR.StepBuilder.prototype.prevStep = function(baseObject, doNotEraseForSubModels) {
    if(this.isAtPreStep()) {
	return false; // Can't move further. Fallback.
    }

    // Step down from placement step:
    if(this.isAtPlacementStep()) {
	if(this.extraParts) {
	    this.extraParts.setVisible(false);
	    LDR.changeBufferSize += 1;
	}
	// Update all previous steps to be old:
	for(var i = 0; i < this.subBuilders.length-1; i++) {
	    var t = this.meshCollectors[i];
	    if(t !== null) {
		t.draw(baseObject, true);
	    }
	    var s = this.subBuilders[i];
	    if(s) {
		s.updateMeshCollectors(baseObject, true);
	    }
	}
	
	this.current--;
	return true;
    }

    var subBuilder = this.subBuilders[this.current];
    if(subBuilder === null) { // Remove standard step:
    	var meshCollector = this.meshCollectors[this.current];
	meshCollector.setVisible(false);
	LDR.changeBufferSize += 1;
	this.stepBack(baseObject);
    }
    else { // There is a subBuilder, so we have to step inside of it:
	if(subBuilder.isAtPlacementStep() && !doNotEraseForSubModels) {
	    this.setVisibleUpTo(false, this.current);
	}
	subBuilder.prevStep(baseObject, doNotEraseForSubModels);
	if(subBuilder.isAtPreStep()) {
	    if(!doNotEraseForSubModels)
		this.setVisibleUpTo(true, this.current);
	    this.stepBack(baseObject);
	}
    }
    return true;
}

LDR.StepBuilder.prototype.stepBack = function(baseObject) {    
    this.current--;
    if(this.current == -1)
	return;
    var t = this.meshCollectors[this.current];
    if(t !== null) {
	t.draw(baseObject, false);
    }
    var s = this.subBuilders[this.current];
    if(s) {
	s.updateMeshCollectors(baseObject, false);
    }
}

LDR.StepBuilder.prototype.fastForward = function(baseObject, onDone) {    
    // Find active builder:
    var b = this;
    while(b.current < b.subBuilders.length && b.subBuilders[b.current] !== null) {
	b = b.subBuilders[b.current];
    }
    var walkedAlready = 0;
    // Step if at last step of builder:    
    if(b.isAtLastStep()) {
	this.nextStep(baseObject, true);
	walkedAlready++;
	// Find active builder now:
	b = this;
	while(b.current < b.subBuilders.length && b.subBuilders[b.current] !== null) {
	    b = b.subBuilders[b.current];
	}
    }

    var walk = function(walked, baseBuilder, builderToComplete, od, op) {
	while(!builderToComplete.isAtLastStep()) {
	    baseBuilder.nextStep(baseObject, true);
	    walked++;
	    if(LDR.changeBufferSize >= THREE.changeBufferLimit) {
		op();
		LDR.changeBufferSize = 0;
		setTimeout(function(){walk(walked, baseBuilder, builderToComplete, od, op)}, 50);
		return;
	    }
	}
	baseBuilder.cleanUpAfterWalking(baseObject);
	od(walked, true);
    }
    walk(walkedAlready, this, b, onDone, this.onProgress);
}

LDR.StepBuilder.prototype.fastReverse = function(baseObject, onDone) {
    // Find active builder:
    var b = this;
    while(b.current < b.subBuilders.length && b.subBuilders[b.current] !== null) {
	b = b.subBuilders[b.current];
    }
    // Step if at last step of builder:
    var walkedAlready = 0;
    if(b.isAtFirstStep()) {
	this.prevStep(baseObject, true);
	walkedAlready--;
	b = this;
	while(b.current < b.subBuilders.length && b.subBuilders[b.current] !== null) {
	    console.log("Stepping into " + b.current);
	    b = b.subBuilders[b.current];
	}
    }

    var walk = function(walked, baseBuilder, builderToComplete, od, op) {
	while(!builderToComplete.isAtFirstStep()) {
	    baseBuilder.prevStep(baseObject, true);
	    walked--;
	    if(LDR.changeBufferSize >= THREE.changeBufferLimit) {
		op();
		LDR.changeBufferSize = 0;
		setTimeout(function(){walk(walked, baseBuilder, builderToComplete, od, op)}, 50);
		return;
	    }
	}
	baseBuilder.cleanUpAfterWalking(baseObject);
	od(walked, true);
    }
    walk(walkedAlready, this, b, onDone, this.onProgress);
}

LDR.StepBuilder.prototype.moveSteps = function(steps, baseObject, onDone) {
    var walked = 0;
    if(steps === 0) {
	this.cleanUpAfterWalking();
	onDone(walked);
	return;
    }
    while(true) {
	// Try to walk:
	if(!(steps > 0 ? this.nextStep(baseObject, true) : this.prevStep(baseObject, true))) {
	    this.cleanUpAfterWalking();
	    onDone(walked);
	    return;
	}
	walked += (steps > 0) ? 1 : -1;
	if(walked == steps) {
	    this.cleanUpAfterWalking();
	    onDone(walked);
	    return;
	}
	else if(LDR.changeBufferSize >= THREE.changeBufferLimit) {
	    this.onProgress();
	    LDR.changeBufferSize = 0;
	    var nextOnDone = function(d) {onDone(walked + d)};
	    var builder = this;
	    var toMove = steps - walked;
	    //console.log("Recursing after " + walked + " of " + steps + " => " + toMove);
	    setTimeout(function(){builder.moveSteps(toMove, baseObject, nextOnDone)}, 50);
	    return; // Done here.
	}
    }
}

LDR.StepBuilder.prototype.isAtPreStep = function() {
    return this.current === -1;
}
LDR.StepBuilder.prototype.isAtFirstStep = function() {
    var subBuilder = this.subBuilders[0];
    return this.current === 0 && ((subBuilder === null) || subBuilder.isAtFirstStep());
}
LDR.StepBuilder.prototype.isAtPlacementStep = function() {
    return this.current == this.subBuilders.length;
}
LDR.StepBuilder.prototype.isAtLastStep = function() {
    if(this.isAtPlacementStep())
	return true;
    if(this.current < this.subBuilders.length-1)
	return false;
    var subBuilder = this.subBuilders[this.current];
    return (subBuilder === null) || subBuilder.isAtPlacementStep();    
}
LDR.StepBuilder.prototype.isAtVeryLastStep = function() {
    return this.isAtLastStep() && !this.extraParts;
}

LDR.StepBuilder.prototype.setVisibleUpTo = function(v, idx) {
    for(var i = 0; i < idx; i++) {
	var t = this.meshCollectors[i];
	if(t !== null) {
	    if(t.isVisible() != v) {
		t.setVisible(v);
		LDR.changeBufferSize += 1;
	    }
	}
	var s = this.subBuilders[i];
	if(s) {
	    s.setVisible(v);
	}
    }
}
LDR.StepBuilder.prototype.setVisible = function(v) {
    this.setVisibleUpTo(v, this.subBuilders.length);
    if(this.extraParts && this.extraParts.isMeshCollector && this.extraParts.isVisible() !== v) {
	LDR.changeBufferSize += 1;
	this.extraParts.setVisible(v);
    }
}

LDR.StepBuilder.prototype.updateMeshCollectors = function(baseObject, old) {
    for(var i = 0; i < this.subBuilders.length; i++) {
	var t = this.meshCollectors[i];
	if(t !== null) {
	    t.draw(baseObject, old);
	}
	var s = this.subBuilders[i];
	if(s) {
	    s.updateMeshCollectors(baseObject, old);
	}
    }
    if(this.extraParts && this.extraParts.isMeshCollector) {
	this.extraParts.draw(baseObject, old);
    }
}

LDR.StepBuilder.prototype.destroy = function() {
    for(var i = 0; i < this.subBuilders.length; i++) {
	var t = this.meshCollectors[i];
	if(t !== null) {
	    t.destroy();
	}
	var s = this.subBuilders[i];
	if(s) {
	    s.destroy();
	}
    }  
}
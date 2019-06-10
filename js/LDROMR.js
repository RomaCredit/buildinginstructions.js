'use strict';

/**
   OMR - see https://www.ldraw.org/article/593.html
 */ 
LDR.OMR = {};

// ~Moved parts:
LDR.OMR.UpgradeToNewParts = {
    title: "Click here to upgrade all moved parts to latest versions.",

    checkers: {checkPartType:pt => pt.replacement},

    handlers: {handlePartDescription: function(pd) {
        let pt = ldrLoader.partTypes[pd.ID];
	if(pt.replacement) {
            pd.ID = pt.replacement;
        }
    }}
}

LDR.OMR.FixAuthors = function(expectedAuthor) {
    let title = "Click here to change all author lines in the models of the LDraw file to '" + expectedAuthor + "' (This does not include any unofficial parts)";

    let checkers = {checkPartType: pt => pt.isPart() ? false : pt.author !== expectedAuthor};
    
    let handlers = {handlePartType: pt => {
        if(pt.isPart())  {
	    return;
	}
        pt.author = expectedAuthor;
    }};

    return {title:title, checkers:checkers};
}
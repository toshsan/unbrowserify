/*jslint node: true */
"use strict";

var uglifyJS = require("uglify-js"),
    fs = require("fs"),
    path = require("path"),
    decompress = require("./decompress");

/* Override printing of variable definitions to output each var on a separate line. */
uglifyJS.AST_Definitions.prototype._do_print = function (output, kind) {
    var self = this,
        p = output.parent(),
        inFor = (p instanceof uglifyJS.AST_For || p instanceof uglifyJS.AST_ForIn) && p.init === this;

    output.print(kind);
    output.space();

    if (inFor) {
        this.definitions.forEach(function (def, i) {
            if (i !== 0) {
                output.comma();
            }
            def.print(output);
        });
    } else {
        output.with_indent(output.indentation() + 4, function () {
            self.definitions.forEach(function (def, i) {
                if (i !== 0) {
                    output.print(",");
                    output.newline();
                    output.indent();
                }

                def.print(output);
            });
        });

        output.semicolon();
    }
};

function parseFile(filename) {
    var code = fs.readFileSync(filename, "utf8"),
        ast = uglifyJS.parse(code, {filename: filename});

    ast.figure_out_scope();
    return ast;
}

function outputCode(ast, filename) {
    var options = {
            beautify: true,
            ascii_only: true,
            bracketize: true
        },
        code = ast.print_to_string(options);

    if (filename) {
        fs.writeFileSync(filename, code);
    } else {
        console.log(code);
    }
}

function findMainFunction(ast) {
    var mainFunctionCall,
        visitor;

    visitor = new uglifyJS.TreeWalker(function (node) {
        if (node instanceof uglifyJS.AST_Call) {
            if (mainFunctionCall === undefined) {
                mainFunctionCall = node;
            } else {
                console.warn("More than one top-level function found.");
            }
            return true;
        }
    });

    ast.walk(visitor);
    return mainFunctionCall;
}

function extractModuleNames(moduleObject, main) {
    var moduleNames = {};

    main.elements.forEach(function (element) {
        moduleNames[element.value] = "main";
    });

    moduleObject.properties.forEach(function (objectProperty) {
        var moduleId = objectProperty.key,
            moduleFunction = objectProperty.value.elements[0],
            requireMapping = objectProperty.value.elements[1];

        /* TODO: Resolve module names relative to output directory. */

        requireMapping.properties.forEach(function (prop) {
            var name = path.basename(prop.key, ".js"),
                id = prop.value.value;

            if (!moduleNames[id]) {
                moduleNames[id] = name;
            } else if (moduleNames[id].toLowerCase() !== name.toLowerCase()) {
                console.warn("More than one name found for module " + id + ":");
                console.warn("    " + moduleNames[id]);
                console.warn("    " + name);
            }
        });
    });

    return moduleNames;
}

function renameArguments(moduleFunction) {
    var argNames = [
        "require", "module", "exports", "moduleSource",
        "loadedModules", "mainIds"
    ];

    /* Rename the function arguments (if needed). The code generator has
     * special logic to display the mangled name if it's present. */
    moduleFunction.argnames.forEach(function (arg, i) {
        if (arg.name !== argNames[i]) {
            arg.thedef.mangled_name = argNames[i];
        }
    });
}

function updateRequires(moduleFunction, mapping) {
    var visitor, name;

    visitor = new uglifyJS.TreeWalker(function (node) {
        if (node instanceof uglifyJS.AST_Call &&
                node.expression instanceof uglifyJS.AST_SymbolRef &&
                (node.expression.name === "require" || node.expression.thedef.mangled_name === "require") &&
                node.args.length === 1 &&
                node.args[0] instanceof uglifyJS.AST_String) {

            name = path.basename(node.args[0].value, ".js");
            if (mapping[name]) {
                node.args[0].value = "./" + mapping[name] + ".js";
            }
        }
    });

    moduleFunction.walk(visitor);
}

function extractModules(moduleObject, moduleNames) {
    var modules = {};

    modules.main = new uglifyJS.AST_Toplevel({body: []});

    moduleObject.properties.forEach(function (objectProperty) {
        var moduleId = objectProperty.key,
            moduleFunction = objectProperty.value.elements[0],
            requireMapping = objectProperty.value.elements[1],
            moduleName = moduleNames[moduleId],
            topLevel,
            mapping = {};

        requireMapping.properties.forEach(function (prop) {
            var name = path.basename(prop.key, ".js"),
                id = prop.value.value;
            mapping[name] = moduleNames[id];
        });

        if (modules[moduleName]) {
            topLevel = modules[moduleName];
        } else {
            topLevel = modules[moduleName] = new uglifyJS.AST_Toplevel({body: []});
        }

        renameArguments(moduleFunction);
        updateRequires(moduleFunction, mapping);

        topLevel.body = topLevel.body.concat(moduleFunction.body);
    });

    return modules;
}

function unbrowserify(filename, outputDirectory) {
    var mainFunction,
        moduleObject,
        main,
        modules,
        moduleNames,
        moduleName,
        moduleFile,
        module,
        ast = parseFile(filename);

    /*
     Top level of each file should be:

     function e(t, n, r){ ... }({ ... }, {}, [ ... ]);

     Where the omitted parts are:
     1) Top level implementation of `require`
     2) Module source
     3) Ids of the `main` module.

     The module source is an object literal, the key is the module's id,
     the value is an array containing the module function and a object
     literal of module name to id mappings.
     */

    mainFunction = findMainFunction(ast);
    if (!mainFunction) {
        console.error(filename + ": unable to find main function.");
        return;
    }

    moduleObject = mainFunction.args[0];
    main = mainFunction.args[2];

    if (!(moduleObject instanceof uglifyJS.AST_Object)) {
        console.error(filename + ": first argument should be an object");
        return;
    }

    moduleNames = extractModuleNames(moduleObject, main);
    modules = extractModules(moduleObject, moduleNames);

    for (moduleName in modules) {
        if (modules.hasOwnProperty(moduleName)) {
            module = modules[moduleName];
            decompress(module);

            moduleFile = path.join(outputDirectory, moduleName + ".js");
            console.log("Writing " + moduleFile);

            outputCode(module, moduleFile);
        }
    }
}

module.exports = {
    outputCode: outputCode,
    findMainFunction: findMainFunction,
    extractModuleNames: extractModuleNames,
    extractModules: extractModules,
    unbrowserify: unbrowserify
};

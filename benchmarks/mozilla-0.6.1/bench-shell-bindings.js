if (typeof load !== "function") {
  var fs = require("fs");
  var vm = require("vm");
  load = function(file) {
    var src = fs.readFileSync(file, "utf8");
    vm.runInThisContext(src);
  };
}

if (typeof print !== "function") {
  print = console.log.bind(console);
}

load(__dirname + "/scalajs-runtime-sourcemap.js");
load(__dirname + "/stats.js");
global.sourceMap = require(__dirname + "/../../source-map.js");
load(__dirname + "/bench.js");

print("Parsing source map");
print(benchmarkParseSourceMap().toString());
print();
print("Serializing source map");
print(benchmarkSerializeSourceMap().toString());

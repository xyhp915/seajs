/**
 * The core of loader
 */
;(function(seajs, util, config) {
	// 模块缓存
	var cachedModules = {}
	// 接口修改缓存
	var cachedModifiers = {}
	// 编译队列
	var compileStack = []
	// 模块状态
	var STATUS = {
		'FETCHING' : 1, // The module file is fetching now. 模块正在下载中
		'FETCHED' : 2, // The module file has been fetched. 模块已下载
		'SAVED' : 3, // The module info has been saved. 模块信息已保存
		'READY' : 4, // All dependencies and self are ready to compile. 模块的依赖项都已下载，等待编译
		'COMPILING' : 5, // The module is in compiling now. 模块正在编译中
		'COMPILED' : 6 // The module is compiled and module.exports is available. 模块已编译
	}

	function Module(uri, status) {
		this.uri = uri
		this.status = status || 0

		// this.id is set when saving
		// this.dependencies is set when saving
		// this.factory is set when saving
		// this.exports is set when compiling
		// this.parent is set when compiling
		// this.require is set when compiling
	}


	Module.prototype._use = function(ids, callback) {
		//转换为数组，统一操作
		util.isString(ids) && ( ids = [ids])
		// 使用模块系统内部的路径解析机制来解析并返回模块路径
		var uris = resolve(ids, this.uri)

		this._load(uris, function() {
			// Loads preload files introduced in modules before compiling.
			// 在编译之前，再次调用preload预加载模块
			// 因为在代码执行期间，随时可以调用seajs.config配置预加载模块
			preload(function() {
				// 编译每个模块，并将各个模块的exports作为参数传递给回调函数
				var args = util.map(uris, function(uri) {
					return uri ? cachedModules[uri]._compile() : null
				})
				if (callback) {
					// null使回调函数中this指针为window
					callback.apply(null, args)
				}
			})
		})
	}
	// 主模块加载依赖模块（称之为子模块），并执行回调函数
	Module.prototype._load = function(uris, callback) {
		// 过滤uris数组
		// 情况一：缓存中不存在该模块，返回其uri
		// 情况二：缓存中存在该模块，但是其status < STATUS.READY（即还没准备好编译）
		var unLoadedUris = util.filter(uris, function(uri) {
			return uri && (!cachedModules[uri] || cachedModules[uri].status < STATUS.READY)
		})
		var length = unLoadedUris.length
		// 如果length为0，表示依赖项为0或者都已下载完成，那么执行回调编译操作
		if (length === 0) {
			callback()
			return
		}

		var remain = length

		for (var i = 0; i < length; i++) {
			// 闭包，为onFetched函数提供上下文环境
			(function(uri) {
				// 创建模块对象
				var module = cachedModules[uri] || (cachedModules[uri] = new Module(uri, STATUS.FETCHING))
				//如果模块已下载，那么执行onFetched，否则执行fetch操作（请求模块）
				module.status >= STATUS.FETCHED ? onFetched() : fetch(uri, onFetched)

				function onFetched() {
					// cachedModules[uri] is changed in un-correspondence case
					module = cachedModules[uri]
					// 如果模块状态为SAVED，表示模块的依赖项已经确定，那么下载依赖模块
					if (module.status >= STATUS.SAVED) {
						// 从模块信息中获取依赖模块列表，并作循环依赖的处理
						var deps = getPureDependencies(module)
						// 如果存在依赖项，继续下载
						if (deps.length) {
							Module.prototype._load(deps, function() {
								cb(module)
							})
						}
						// 否则直接执行cb
						else {
							cb(module)
						}
					}
					// Maybe failed to fetch successfully, such as 404 or non-module.
					// In these cases, just call cb function directly.
					// 如果下载模块不成功，比如404或者模块不规范（代码出错），导致此时模块状态可能为fetching，或者fetched
					// 此时直接执行回调函数，在编译模块时，该模块就只会返回null
					else {
						cb()
					}
				}

			})(unLoadedUris[i])
		}

		function cb(module) {
			// 更改模块状态为READY，当remain为0时表示模块依赖都已经下完，那么执行callback
			(module || {}).status < STATUS.READY && (module.status = STATUS.READY)--
			remain === 0 && callback()
		}

	}

	Module.prototype._compile = function() {
		var module = this
		// 如果该模块已经编译过，则直接返回module.exports
		if (module.status === STATUS.COMPILED) {
			return module.exports
		}

		// Just return null when:
		// 1. the module file is 404.
		// 2. the module file is not written with valid module format.
		// 3. other error cases.
		// 这里是处理一些异常情况，此时直接返回null
		if (module.status < STATUS.SAVED && !hasModifiers(module)) {
			return null
		}
		// 更改模块状态为COMPILING，表示模块正在编译
		module.status = STATUS.COMPILING

		// 模块内部使用，是一个方法，用来获取其他模块提供（称之为子模块）的接口，同步操作
		function require(id) {
			// 根据id解析模块的路径
			var uri = resolve(id, module.uri)
			// 从模块缓存中获取模块（注意，其实这里子模块作为主模块的依赖项是已经被下载下来的）
			var child = cachedModules[uri]

			// Just return null when uri is invalid.
			// 如果child为空，只能表示参数填写出错导致uri不正确，那么直接返回null
			if (!child) {
				return null
			}

			// Avoids circular calls.
			// 如果子模块的状态为STATUS.COMPILING，直接返回child.exports，避免因为循环依赖反复编译模块
			if (child.status === STATUS.COMPILING) {
				return child.exports
			}
			// 指向初始化时调用当前模块的模块。根据该属性，可以得到模块初始化时的Call Stack.
			child.parent = module
			// 返回编译过的child的module.exports
			return child._compile()
		}

		// 模块内部使用，用来异步加载模块，并在加载完成后执行指定回调。
		require.async = function(ids, callback) {
			module._use(ids, callback)
		}
		// 使用模块系统内部的路径解析机制来解析并返回模块路径。该函数不会加载模块，只返回解析后的绝对路径。
		require.resolve = function(id) {
			return resolve(id, module.uri)
		}
		// 通过该属性，可以查看到模块系统加载过的所有模块。
		// 在某些情况下，如果需要重新加载某个模块，可以得到该模块的 uri, 然后通过 delete require.cache[uri] 来将其信息删除掉。这样下次使用时，就会重新获取。
		require.cache = cachedModules

		// require是一个方法，用来获取其他模块提供的接口。
		module.require = require
		// exports是一个对象，用来向外提供模块接口。
		module.exports = {}
		var factory = module.factory

		// factory 为函数时，表示模块的构造方法。执行该方法，可以得到模块向外提供的接口。
		if (util.isFunction(factory)) {
			compileStack.push(module)
			runInModuleContext(factory, module)
			compileStack.pop()
		}
		// factory 为对象、字符串等非函数类型时，表示模块的接口就是该对象、字符串等值。
		// 如：define({ "foo": "bar" });
		// 如：define('I am a template. My name is {{name}}.');
		else if (factory !== undefined) {
			module.exports = factory
		}

		// 更改模块状态为COMPILED，表示模块已编译
		module.status = STATUS.COMPILED
		// 执行模块接口修改，通过seajs.modify()
		execModifiers(module)
		return module.exports
	}

	Module._define = function(id, deps, factory) {
		var argsLength = arguments.length
		// 根据传入的参数个数，进行参数匹配

		// define(factory)
		// 一个参数的情况：
		// id : undefined
		// deps : undefined(后面会根据正则取出依赖模块列表)
		// factory : function
		if (argsLength === 1) {
			factory = id
			id = undefined
		}
		// define(id || deps, factory)
		// 两个参数的情况：
		
else if (argsLength === 2) {
			// 默认情况下 ：define(id, factory)
			// id : '...'
			// deps : undefined
			// factory : function
			factory = deps
			deps = undefined

			// define(deps, factory)
			// 如果第一个参数为数组 ：define(deps, factory)
			// id : undefined
			// deps : [...]
			// factory : function
			if (util.isArray(id)) {
				deps = id
				id = undefined
			}
		}

		// Parses dependencies.
		// 如果deps不是数组（即deps未指定值），那么通过正则表达式解析依赖
		if (!util.isArray(deps) && util.isFunction(factory)) {
			deps = util.parseDependencies(factory.toString())
		}

		// 元信息，之后会将信息传递给对应的module对象中
		var meta = {
			id : id,
			dependencies : deps,
			factory : factory
		}
		var derivedUri

		// Try to derive uri in IE6-9 for anonymous modules.
		// 对于IE6-9，尝试通过interactive script获取模块的uri
		if (document.attachEvent) {
			// Try to get the current script.
			// 获取当前的script
			var script = util.getCurrentScript()
			if (script) {
				// 将当前script的url进行unpareseMap操作，与模块缓存中key保持一致
				derivedUri = util.unParseMap(util.getScriptAbsoluteSrc(script))
			}

			if (!derivedUri) {
				util.log('Failed to derive URI from interactive script for:', factory.toString(), 'warn')

				// NOTE: If the id-deriving methods above is failed, then falls back
				// to use onload event to get the uri.
			}
		}

		// Gets uri directly for specific module.
		// 如果给定id，那么根据id解析路径
		// 显然如果没指定id：
		// 对于非IE浏览器而言，则返回undefined（derivedUri为空）
		// 对于IE浏览器则返回CurrentScript的src
		// 如果指定id：
		// 则均返回有seajs解析（resolve）过的路径url
		var resolvedUri = id ? resolve(id) : derivedUri
		// uri存在的情况，进行模块信息存储
		if (resolvedUri) {
			// For IE:
			// If the first module in a package is not the cachedModules[derivedUri]
			// self, it should assign to the correct module when found.
			if (resolvedUri === derivedUri) {
				var refModule = cachedModules[derivedUri]
				if (refModule && refModule.realUri && refModule.status === STATUS.SAVED) {
					cachedModules[derivedUri] = null
				}
			}
			// 存储模块信息
			var module = save(resolvedUri, meta)

			// For IE:
			// Assigns the first module in package to cachedModules[derivedUrl]
			if (derivedUri) {
				// cachedModules[derivedUri] may be undefined in combo case.
				if ((cachedModules[derivedUri] || {}).status === STATUS.FETCHING) {
					cachedModules[derivedUri] = module
					module.realUri = derivedUri
				}
			} else {
				// 将第一个模块存储到firstModuleInPackage
				firstModuleInPackage || ( firstModuleInPackage = module)
			}
		}
		// uri不存在的情况，在onload回调中进行模块信息存储，那里有个闭包
		else {
			// Saves information for "memoizing" work in the onload event.
			// 因为此时的uri不知道，所以将元信息暂时存储在anonymousModuleMeta中，在onload回调中进行模块save操作
			anonymousModuleMeta = meta
		}

	}
	// 获取正在编译的模块
	Module._getCompilingModule = function() {
		return compileStack[compileStack.length - 1]
	}
	// 从seajs.cache中快速查看和获取已加载的模块接口，返回值是module.exports数组
	// selector 支持字符串和正则表达式
	Module._find = function(selector) {
		var matches = []

		util.forEach(util.keys(cachedModules), function(uri) {
			if (util.isString(selector) && uri.indexOf(selector) > -1 || util.isRegExp(selector) && selector.test(uri)) {
				var module = cachedModules[uri]
				module.exports && matches.push(module.exports)
			}
		})

		return matches
	}
	// 修改模块接口
	Module._modify = function(id, modifier) {
		var uri = resolve(id)
		var module = cachedModules[uri]
		// 如果模块存在，并且处于COMPILED状态，那么执行修改接口操作
		if (module && module.status === STATUS.COMPILED) {
			runInModuleContext(modifier, module)
		}
		// 否则放入修改接口缓存中
		else {
			cachedModifiers[uri] || (cachedModifiers[uri] = [])
			cachedModifiers[uri].push(modifier)
		}

		return seajs
	}
	// For plugin developers
	Module.STATUS = STATUS
	Module._resolve = util.id2Uri
	Module._fetch = util.fetch
	Module.cache = cachedModules

	// Helpers
	// -------
	// 正在下载的模块列表
	var fetchingList = {}
	// 已下载的模块列表
	var fetchedList = {}
	// 回调函数列表
	var callbackList = {}
	// 匿名模块元信息
	var anonymousModuleMeta = null
	var firstModuleInPackage = null
	// 循环依赖栈
	var circularCheckStack = []

	// 批量解析模块的路径
	function resolve(ids, refUri) {
		if (util.isString(ids)) {
			return Module._resolve(ids, refUri)
		}

		return util.map(ids, function(id) {
			return resolve(id, refUri)
		})
	}

	function fetch(uri, callback) {
		// fetch时，首先将uri按map规则转换
		var requestUri = util.parseMap(uri)
		// 在fethedList（已下载的模块列表）中查找，有的话，直接返回，并执行回调函数
		// TODO : 为什么这一步，fetchedList可能会存在该模？
		if (fetchedList[requestUri]) {
			// See test/issues/debug-using-map
			cachedModules[uri] = cachedModules[requestUri]
			callback()
			return
		}
		// 在fetchingList（正在在下载的模块列表）中查找，有的话，只需添加回调函数到列表中去，然后直接返回
		if (fetchingList[requestUri]) {
			callbackList[requestUri].push(callback)
			return
		}
		// 如果走到这一步，表示该模块是第一次被请求，
		// 那么在fetchingList插入该模块的信息，表示该模块已经处于下载列表中，并初始化该模块对应的回调函数列表
		fetchingList[requestUri] = true
		callbackList[requestUri] = [callback]

		// Fetches it
		// 获取该模块，即发起请求
		Module._fetch(requestUri, function() {
			// 在fetchedList插入该模块的信息，表示该模块已经下载完成
			fetchedList[requestUri] = true

			// Updates module status
			var module = cachedModules[uri]
			// 此时status可能为STATUS.SAVED，之前在_define中已经说过
			if (module.status === STATUS.FETCHING) {
				module.status = STATUS.FETCHED
			}

			// Saves anonymous module meta data
			// 因为是匿名模块（此时通过闭包获取到uri，在这里存储模块信息）
			// 并将anonymousModuleMeta置为空
			if (anonymousModuleMeta) {
				save(uri, anonymousModuleMeta)
				anonymousModuleMeta = null
			}

			// Assigns the first module in package to cachedModules[uri]
			// See: test/issues/un-correspondence
			if (firstModuleInPackage && module.status === STATUS.FETCHED) {
				cachedModules[uri] = firstModuleInPackage
				firstModuleInPackage.realUri = uri
			}
			firstModuleInPackage = null

			// Clears
			// 在fetchingList清除模块信息，因为已经该模块fetched并save
			if (fetchingList[requestUri]) {
				delete fetchingList[requestUri]
			}

			// Calls callbackList
			// 依次调用回调函数，并清除回调函数列表
			if (callbackList[requestUri]) {
				util.forEach(callbackList[requestUri], function(fn) {
					fn()
				})
				delete callbackList[requestUri]
			}

		}, config.charset)
	}

	function save(uri, meta) {
		var module = cachedModules[uri] || (cachedModules[uri] = new Module(uri))

		// Don't override already saved module
		// 此时status可能有两个状态：
		// STATUS.FETCHING，在define里面调用（指定了id），存储模块信息
		// STATUS.FETCHED，在onload的回调函数里调用，存储模块信息
		if (module.status < STATUS.SAVED) {
			// Lets anonymous module id equal to its uri
			// 匿名模块（即没有指定id），用它的uri作为id
			module.id = meta.id || uri
			// 将依赖项（数组）解析成的绝对路径，存储到模块信息中
			module.dependencies = resolve(util.filter(meta.dependencies || [], function(dep) {
				return !!dep
			}), uri)
			// 存储factory（要执行的模块代码，也可能是对象或者字符串等）
			module.factory = meta.factory

			// Updates module status
			// 更新模块状态为SAVED，（注意此时它只是拥有了依赖项，还未全部下载下来（即还未READY））
			module.status = STATUS.SAVED
		}

		return module
	}

	// 根据模块上下文执行模块代码
	function runInModuleContext(fn, module) {
		// 传入与模块相关的两个参数以及模块自身
		// exports用来暴露接口
		// require用来获取依赖模块（同步）（编译）
		var ret = fn(module.require, module.exports, module)
		// 支持返回值暴露接口形式，如：
		// return {
		// fn1 : xx
		// ,fn2 : xx
		// ...
		// }
		if (ret !== undefined) {
			module.exports = ret
		}
	}

	// 判断模块是否存在接口修改
	function hasModifiers(module) {
		return !!cachedModifiers[module.realUri || module.uri]
	}

	// 修改模块接口
	function execModifiers(module) {
		var uri = module.realUri || module.uri
		var modifiers = cachedModifiers[uri]
		// 内部变量 cachedModifiers 就是用来存储用户通过 seajs.modify 方法定义的修改点
		// 查看该uri是否又被modify更改过
		if (modifiers) {
			// 对修改点统一执行factory，返回修改后的module.exports
			util.forEach(modifiers, function(modifier) {
				runInModuleContext(modifier, module)
			})
			// 删除 modify 方法定义的修改点 ，避免再次执行
			delete cachedModifiers[uri]
		}
	}

	//获取纯粹的依赖关系，得到不存在循环依赖关系的依赖数组
	function getPureDependencies(module) {
		var uri = module.uri
		// 对每个依赖项进行过滤，对于有可能形成循环依赖的进行剔除，并打印出警告日志
		return util.filter(module.dependencies, function(dep) {
			// 首先将被检查模块的uri放到循环依赖检查栈中，之后的检查会用到
			circularCheckStack = [uri]
			//接下来检查模块uri是否和其依赖的模块存在循环依赖
			var isCircular = isCircularWaiting(cachedModules[dep])
			if (isCircular) {
				// 如果循环，则将uri放到循环依赖检查栈中
				circularCheckStack.push(uri)
				// 打印出循环警告日志
				printCircularLog(circularCheckStack)
			}

			return !isCircular
		})
	}

	function isCircularWaiting(module) {
		// 如果依赖模块不存在，那么返回false，因为此时也无法获得依赖模块的依赖项，所以这里无法做判断
		// 或者如果模块的状态值等于saved，也返回false，因为模块状态为saved的时候代表该模块的信息已经有了，
		// 所以尽管形成了循环依赖，但是require主模块时，同样可以正常编译，返回主模块接口（好像nodejs会返回undefined）
		if (!module || module.status !== STATUS.SAVED) {
			return false
		}
		// 如果不是以上的情况，那么将依赖模块的uri放到循环依赖检查栈中，之后的检查会用到
		circularCheckStack.push(module.uri)
		// 再次取依赖模块的依赖模块
		var deps = module.dependencies

		if (deps.length) {
			// 通过循环依赖检查栈，检查是否存在循环依赖（这里是第一层依赖模块检查，与主模块循环依赖的情况）
			if (isOverlap(deps, circularCheckStack)) {
				return true
			}
			// 如果不存在上述情形，那么进一步查看，依赖模块的依赖模块，查看他们是否存在对循环依赖检查栈中的uri的模块存在循环依赖
			// 这样的话，就递归了，循环依赖检查栈就像形成的一条链，当前模块依次对主模块，主模块的主模块...直到最顶上的主模块，依次进行判断是否存在依赖
			for (var i = 0; i < deps.length; i++) {
				if (isCircularWaiting(cachedModules[deps[i]])) {
					return true
				}
			}
		}
		// 如果不存在循环依赖，那么pop出之前已经push进的模块uri，并返回false
		circularCheckStack.pop()
		return false
	}

	// 打印出循环警告日志
	function printCircularLog(stack, type) {
		util.log('Found circular dependencies:', stack.join(' --> '), type)
	}

	//判断两个数组是否有重复的值
	function isOverlap(arrA, arrB) {
		var arrC = arrA.concat(arrB)
		return arrC.length > util.unique(arrC).length
	}

	// 从配置文件读取是否有需要提前加载的模块
	// 如果有预先加载模块，首先设置预加载模块为空（保证下次不必重复加载），并加载预加载模块并执行回调，如果没有则顺序执行
	function preload(callback) {
		var preloadMods = config.preload.slice()
		config.preload = []
		preloadMods.length ? globalModule._use(preloadMods, callback) : callback()
	}

	// Public API
	// 对外暴露的API
	// ----------
	// 全局模块，可以认为是页面模块，页面中的js，css文件都是通过它来载入的
	// 模块初始状态就是COMPILED，uri就是页面的uri
	var globalModule = new Module(util.pageUri, STATUS.COMPILED)

	// 页面js，css文件加载器
	seajs.use = function(ids, callback) {
		// Loads preload modules before all other modules.
		// 预加载模块
		preload(function() {
			globalModule._use(ids, callback)
		})
		// Chain
		return seajs
	}
	// For normal users
	// 供普通用户调用
	seajs.define = Module._define
	seajs.cache = Module.cache
	seajs.find = Module._find
	seajs.modify = Module._modify

	// For plugin developers
	// 供开发者使用
	seajs.pluginSDK = {
		Module : Module,
		util : util,
		config : config
	}

})(seajs, seajs._util, seajs._config) 
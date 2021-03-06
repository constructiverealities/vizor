function Player() {
	this.state = {
		STOPPED: 0,
		LOADING: 1,
		READY: 2,
		PAUSED: 3,
		PLAYING: 4
	}

	this.app = E2.app
	this.core = E2.core

	this.interval = null
	this.abs_time = 0.0
	this.last_time = (new Date()).getTime()

	this._current_state = this.state.STOPPED
	Object.defineProperty(this, 'current_state', {
		get: function() {
			return this._current_state
		},
		set: function(newState) {
			var oldState = this._current_state
			this._current_state = newState
			E2.core.emit('player:stateChanged', newState, oldState)
		}
	})

	this.frames = 0
	this.scheduled_stop = null

	this.current_state = this.state.STOPPED
	
	this.core.active_graph = this.core.root_graph = new Graph(this.core, null, 'root')
	this.core.graphs.push(this.core.root_graph)

	var canvas = E2.dom.webgl_canvas[0]
	this.vrControlCamera = new THREE.PerspectiveCamera(
				90,
				canvas.clientWidth / canvas.clientHeight,
				0.001,
				1000)

	this.concatenatedCamera = this.vrControlCamera.clone()

	this.setupInput()

	this.boundOnAnimFrame = this.on_anim_frame.bind(this)
}

Player.prototype.setupInput = function() {
	this.rayInput = new RayInput.default(this.concatenatedCamera, E2.dom.webgl_canvas[0])
	this.rayInput.setSize({ width: 0, height: 0 })
	
	var el = document.body

	this.rayInput.on('raydown', function(mesh) {
		if (!mesh || E2.app.worldEditor.isActive())
			return;

		E2.core.runtimeEvents.emit('raydown:'+mesh.uuid)
	})

	this.rayInput.on('rayup', function(mesh) {
		if (!mesh || E2.app.worldEditor.isActive())
			return;

		E2.core.runtimeEvents.emit('rayup:'+mesh.uuid)

	})

	this.rayInput.on('rayover', function(mesh) {
		if (!mesh || E2.app.worldEditor.isActive())
			return;

		el.style.cursor = 'pointer'

		E2.core.runtimeEvents.emit('rayover:'+mesh.uuid)
	})

	this.rayInput.on('rayout', function(mesh) {
		if (!mesh || E2.app.worldEditor.isActive())
			return;

		el.style.cursor = ''

		E2.core.runtimeEvents.emit('rayout:'+mesh.uuid)
	})

	E2.core.on('resize', function(evt) {
		E2.app.player.rayInput.setSize(evt)
	})
}

Player.prototype.play = function() {
	if (this.current_state === this.state.PLAYING)
		return;

	this.core.root_graph.play()
	this.current_state = this.state.PLAYING
	this.last_time = (new Date()).getTime()

	this.first_frame = true

	E2.core.emit('player:playing')

	if (!this.interval) {
		this.interval = E2.util.requestAnimationFrame(this.boundOnAnimFrame)
	}
}

Player.prototype.pause = function() {
	this.current_state = this.state.PAUSED
	
	this.core.root_graph.pause()
}

Player.prototype.schedule_stop = function(delegate) {
	this.scheduled_stop = delegate
}

Player.prototype.stop = function() {
	if (this.interval !== null) {
		E2.util.cancelAnimationFrame(this.interval)
		this.interval = null
	}
	
	this.core.root_graph.stop()

	this.abs_time = 0.0
	this.frames = 0
	this.current_state = this.state.STOPPED
	this.core.abs_t = 0.0

	this.core.root_graph.reset()
	
	if (E2.app && E2.app.updateCanvas)
		E2.app.updateCanvas(false)
}

Player.prototype.on_anim_frame = function() {
	this.interval = E2.util.requestAnimationFrame(this.boundOnAnimFrame)

	this.on_update()

	if (this.first_frame) {
		E2.core.emit('player:firstFramePlayed')
		this.first_frame = false
	}
}

Player.prototype.on_update = function() {
	if (this.scheduled_stop) {
		this.stop()
		this.scheduled_stop()
		this.scheduled_stop = null
		return
	}

	var time = this.current_state !== this.state.PAUSED ? Date.now() : this.last_time
	var delta_t = (time - this.last_time) * 0.001
	
	if (this.core.update(this.abs_time, delta_t) && E2.app.updateCanvas)
		E2.app.updateCanvas(false)

	E2.app.worldEditor.update()

	this.last_time = time
	this.abs_time += delta_t
	this.frames++
}

Player.prototype.select_active_graph = function() {
	// Select the active graph and build its UI, but only if there's an editor present
	if (E2.app && E2.app.onGraphSelected)
		E2.app.onGraphSelected(this.core.active_graph)
}

Player.prototype.load_from_json = function(json, cb) {
	this.load_from_object(JSON.parse(json), cb)
}

Player.prototype.load_from_object = function(obj, cb) {
	var c = this.core
	c.deserialiseObject(obj)

	this.current_state = this.state.LOADING

	E2.core.assetLoader
		.loadAssetsForGraph(obj.root)
		.then(function() {
			if (cb)
				cb()
		})
		.catch(function(err) {
			console.error('Player preload failed: '+err)

			if (cb)
				cb(err)
		})
		.finally(function() {
			E2.core.emit('assetsLoaded')
		})
}

Player.prototype.load_from_url = function(url, cb) {
	var that = this

	$.ajax({
		url: url,
		cache: true,
		dataType: 'text',
		headers: {},
		success: function(json) {
			that.load_from_json(json, cb)
		}
	})

	this.current_state = this.state.LOADING

	E2.core.emit('player:loading')
}

Player.prototype.getVariableValue = function(id) {
	return this.core.root_graph.variables.read(id)
}

Player.prototype.setVariableValue = function(id, value) {
	this.core.root_graph.variables.write(id, value)
}

Player.prototype.add_parameter_listener = function(id, listener) {
	var l = {
		variable_dt_changed: function() {},
		variable_updated: function(h) { return function(value) { h(value) }}(listener)
	}
	
	this.core.root_graph.variables.lock(l, id)
	return l
}

Player.prototype.remove_parameter_listener = function(id, listener) {
	this.core.variables.unlock(listener, id)
}

Player.prototype.loadGraph = function(url) {
	var dfd = when.defer()

	// if there's an existing anim frame request, cancel it
	// so that nothing gets rendered until we ask to play() again after loading
	if (this.interval !== null) {
		E2.util.cancelAnimationFrame(this.interval)
		this.interval = null
	}

	if (E2.core.audioContext && E2.util.isMobile.iOS()) {
		// iOS requires a user interaction to play sound. as this is called 
		// on touchstart, create a dummy audio source and play it
		var audioSource = E2.core.audioContext.createBufferSource()
		audioSource.start()
	}

	E2.app.player.load_from_url(url, function(err) {
		if (err)
			return dfd.reject(err)

		dfd.resolve()
	})

	return dfd.promise
}

Player.prototype.loadAndPlay = function(url) {
	var that = this

	return this.loadGraph(url)
	.catch(function(err) {
		if (err)
			console.error(err.stack)
	})
	.finally(function() {
		that.current_state = that.state.READY

		if (Vizor.hasVideo && VizorUI.isMobile.Android())
			return

		return E2.app.player.play()
	})
}

Player.prototype.getScreenshot = function(width, height) {
	width = width || 1280
	height = height || 720
	var ssr = new ScreenshotRenderer(this.scene, this.vrControlCamera)
	return ssr.capture(width, height)
}

function CreatePlayer(cb) {
	$(document).ajaxError(function(e, jqxhr, settings, ex) {
		if(typeof(ex) === 'string') {
			console.log(ex)
			return
		}

		var m = 'ERROR: Script exception:\n'
		
		if(ex.fileName)
			m += '\tFilename: ' + ex.fileName

		if(ex.lineNumber)
			m += '\tLine number: ' + ex.lineNumber
		
		if(ex.message)
			m += '\tMessage: ' + ex.message

		console.log(m)
	})
	
	E2.core = new Core()
	
	E2.dom.webgl_canvas = $('#webgl-canvas')

	if (E2.dom.webgl_canvas.length < 1)
		return

	E2.app = {}
	E2.app.player = new Player()
	E2.app.worldEditor = {
		update: function() {},
		isActive: function() {
			return false
		}
	}

	E2.app.canInitiateCameraMove = function(e) {
		return (e && e.target.tagName === 'CANVAS')  // #790
	}

	WebVRConfig.canInitiateCameraMove = E2.app.canInitiateCameraMove

	// Shared gl context for three
	var gl_attributes = {
		alpha: true,
		depth: true,
		stencil: true,
		antialias: true,
		premultipliedAlpha: true,
		preserveDrawingBuffer: false
	}

	E2.core.glContext = E2.dom.webgl_canvas[0].getContext('webgl', gl_attributes) ||
		E2.dom.webgl_canvas[0].getContext('experimental-webgl', gl_attributes)
	
	E2.core.renderer = new THREE.WebGLRenderer({
		antialias: true,
		context: E2.core.glContext,
		canvas: E2.dom.webgl_canvas[0]
	})

	E2.core.webVRAdapter.initialise(E2.dom.webgl_canvas[0], E2.core.renderer)

	E2.core.on('ready', cb)
}

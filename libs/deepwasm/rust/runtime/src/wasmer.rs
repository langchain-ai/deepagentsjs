use std::sync::Arc;

use anyhow::Context;
use bytes::{Bytes, BytesMut};
use futures::{channel::oneshot, TryStreamExt};
use js_sys::{JsString, Reflect, Uint8Array};
use sha2::Digest;
use tracing::Instrument;
use virtual_fs::{AsyncReadExt, Pipe, RootFileSystemBuilder};
use wasm_bindgen::{prelude::wasm_bindgen, JsValue, UnwrapThrowExt};
use wasmer_config::{
    hash::Sha256Hash,
    package::{PackageHash, PackageId, PackageSource},
};
use wasmer_package::package::Package;
use wasmer_types::ModuleHash;
use wasmer_config::package::SuggestedCompilerOptimizations;
use wasmer_wasix::{
    bin_factory::{BinaryPackage, BinaryPackageCommand},
    os::{Tty, TtyOptions},
    runtime::module_cache::HashedModuleData,
    runtime::task_manager::TaskWasm,
    runners::wasi::{PackageOrHash, WasiRunner, RuntimeOrEngine},
    Runtime as _,
    VirtualTaskManager as _,
    WasiError,
};
use web_sys::{ReadableStream, WritableStream};
use webc::{indexmap::IndexMap, metadata::Command as MetadataCommand, metadata::annotations::Wasi};

use crate::{
    instance::ExitCondition,
    runtime::Runtime,
    utils::{Error, GlobalScope},
    Instance, JsRuntime, SpawnOptions,
};

/// A package from the Wasmer registry.
///
/// @example
/// ```ts
/// import { Wasmer } from "@wasmer/sdk";
///
/// const pkg = await Wasmer.fromRegistry("wasmer/python");
/// const instance = await pkg.entrypoint!.run({ args: ["--version"]});
/// const { ok, code, stdout, stderr } = await instance.wait();
///
/// if (ok) {
///     console.log(`Version:`, stdout);
/// } else {
///     throw new Error(`Python exited with ${code}: ${stderr}`);
/// }
/// ```
#[derive(Debug, Clone, wasm_bindgen_derive::TryFromJsValue)]
#[wasm_bindgen]
pub struct Wasmer {
    /// The package's entrypoint.
    #[wasm_bindgen(getter_with_clone)]
    pub entrypoint: Option<Command>,
    /// A map containing all commands available to the package (including
    /// dependencies).
    #[wasm_bindgen(getter_with_clone)]
    pub commands: Commands,

    #[wasm_bindgen(getter_with_clone)]
    pub pkg: Option<UserPackageDefinition>,
}

#[derive(Debug, Clone, wasm_bindgen_derive::TryFromJsValue)]
#[wasm_bindgen]
pub struct UserPackageDefinition {
    pub(crate) manifest: wasmer_config::package::Manifest,
    pub(crate) data: bytes::Bytes,
    #[wasm_bindgen(getter_with_clone)]
    pub hash: String,
}

#[wasm_bindgen]
impl Wasmer {
    /// Load a package from a package file.
    #[wasm_bindgen(js_name = "fromFile")]
    pub async fn js_from_file(
        binary: Uint8Array,
        runtime: Option<OptionalRuntime>,
    ) -> Result<Wasmer, Error> {
        let bytes = binary.to_vec();
        if bytes.starts_with(b"\0asm") {
            // If the user provides bytes similar to Wasm, we don't assume
            // we are provided a package, but a Wasm file
            Wasmer::from_wasm(bytes, runtime)
        } else {
            Wasmer::from_file(bytes, runtime).await
        }
    }

    /// Load a package from a package file.
    #[wasm_bindgen(js_name = "fromWasm")]
    pub fn js_from_wasm(
        binary: Uint8Array,
        runtime: Option<OptionalRuntime>,
    ) -> Result<Wasmer, Error> {
        Wasmer::from_wasm(binary.to_vec(), runtime)
    }
}

/// The actual impl - with `#[tracing::instrument]` macros.
impl Wasmer {
    #[tracing::instrument(skip(runtime))]
    async fn from_file(binary: Vec<u8>, runtime: Option<OptionalRuntime>) -> Result<Self, Error> {
        let runtime = runtime.unwrap_or_default().resolve()?.into_inner();
        let version = webc::detect(&mut (&*binary))?;
        let container = webc::Container::from_bytes_and_version(binary.into(), version)?;
        let pkg = BinaryPackage::from_webc(&container, &*runtime).await?;

        Wasmer::from_package(pkg, runtime)
    }

    fn from_package(pkg: BinaryPackage, runtime: Arc<Runtime>) -> Result<Self, Error> {
        let pkg = Arc::new(pkg);
        let commands = Commands::default();

        for cmd in &pkg.commands {
            let name = JsString::from(cmd.name());
            let value = JsValue::from(Command {
                name: name.clone(),
                runtime: Arc::clone(&runtime),
                pkg: Arc::clone(&pkg),
            });
            Reflect::set(&commands, &name, &value).map_err(Error::js)?;
        }

        let entrypoint = pkg.entrypoint_cmd.as_deref().map(|name| Command {
            name: name.into(),
            pkg: Arc::clone(&pkg),
            runtime,
        });

        Ok(Wasmer {
            entrypoint,
            commands,
            pkg: None,
        })
    }

    fn from_wasm(wasm: Vec<u8>, runtime: Option<OptionalRuntime>) -> Result<Self, Error> {
        let webc_fs = RootFileSystemBuilder::default().build();
        let hash = ModuleHash::xxhash(&wasm);
        let metadata = MetadataCommand {
            runner: "wasi".to_string(),
            annotations: IndexMap::new(),
        };
        let suggested_compiler_optimizations = SuggestedCompilerOptimizations {
            pass_params: Some(true),
        };
        let package = BinaryPackage {
            id: PackageId::Hash(PackageHash::Sha256(Sha256Hash::from_bytes([0; 32]))),
            package_ids: vec![],
            hash: hash.clone().into(),
            uses: vec![],
            webc_fs: Arc::new(webc_fs),
            when_cached: None,
            file_system_memory_footprint: 0,
            entrypoint_cmd: Some("entrypoint".to_string()),
            commands: vec![BinaryPackageCommand::new(
                "entrypoint".to_string(),
                metadata,
                wasm.into(),
                hash,
                None,
                suggested_compiler_optimizations
            )],
            additional_host_mapped_directories: vec![],
        };
        let runtime = runtime.unwrap_or_default().resolve()?.into_inner();
        Self::from_package(package, runtime)
    }

    pub(crate) async fn from_user_package(
        pkg: Package,
        manifest: wasmer_config::package::Manifest,
        runtime: Arc<Runtime>,
    ) -> Result<Self, Error> {
        let data: Bytes = pkg
            .serialize()
            .context("While validating the package")?
            .to_vec()
            .into();

        let hash = sha2::Sha256::digest(&data).into();
        let hash = wasmer_config::package::PackageHash::from_sha256_bytes(hash);
        let hash = hash.to_string();
        let version = webc::detect(&mut (&*data))?;
        let container = webc::Container::from_bytes_and_version(data.clone(), version)?;
        let bin_pkg = BinaryPackage::from_webc(&container, &*runtime).await?;
        let mut ret = Wasmer::from_package(bin_pkg, runtime)?;
        ret.pkg = Some(UserPackageDefinition {
            manifest,
            data,
            hash,
        });
        Ok(ret)
    }
}

/// A runnable WASIX command.
#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct Command {
    #[wasm_bindgen(getter_with_clone)]
    pub name: JsString,
    pkg: Arc<BinaryPackage>,
    runtime: Arc<Runtime>,
}

#[wasm_bindgen]
impl Command {
    pub async fn run(&self, options: Option<SpawnOptions>) -> Result<Instance, Error> {
        let runtime = Arc::new(self.runtime.with_default_pool());
        let pkg = Arc::clone(&self.pkg);

        let options = options.unwrap_or_default();

        let mut runner = WasiRunner::new();
        let (stdin, stdout, stderr) = configure_runner(&options, &mut runner, &runtime).await?;
        let command_name = String::from(&self.name);

        tracing::debug!(%command_name, "Starting the WASI runner");

        // Build the WASI environment on the main thread.
        let wasi = Wasi::new(&command_name);
        let builder = runner.prepare_webc_env(
            &command_name,
            &wasi,
            PackageOrHash::Package(&pkg),
            RuntimeOrEngine::Runtime(Arc::clone(&runtime) as Arc<dyn wasmer_wasix::Runtime + Send + Sync>),
            None,
        ).map_err(|e| anyhow::anyhow!("{e}"))?;
        let env = builder.build().map_err(|e| anyhow::anyhow!("{e}"))?;

        // Get the command's WASM atom and compile it to a module
        let cmd = pkg.get_command(&command_name)
            .ok_or_else(|| anyhow::anyhow!("Command '{}' not found", &command_name))?;
        let atom = cmd.atom();
        let hashed = HashedModuleData::new(atom.as_ref());
        let module: wasmer::Module = runtime.load_hashed_module(hashed, None).await?;

        let (sender, receiver) = oneshot::channel();

        // Dispatch the WASI module to a web worker via task_wasm().
        //
        // task_wasm handles shared memory setup (serializing/deserializing
        // the module + WasiEnv across the worker boundary). We call _start
        // directly instead of run_exec() because run_exec's error handling
        // uses RuntimeError::downcast::<WasiError>() which always fails in
        // the JS WASM backend (the JS exception round-trip loses typed error
        // info), causing every non-zero exit to be reported as NOEXEC (45).
        let tasks = runtime.task_manager().clone();
        tasks.task_wasm(
            TaskWasm::new(
                Box::new(move |props| {
                    let exit = run_wasi_from_props(props);
                    let _ = sender.send(exit);
                }),
                env,
                module,
                true,  // update_layout
                true,  // call_initialize
            ),
        )?;

        Ok(Instance {
            stdin,
            stdout,
            stderr,
            exit: receiver,
        })
    }

    /// Read the binary that will be
    pub fn binary(&self) -> Uint8Array {
        let name = String::from(&self.name);
        let cmd = self.pkg.get_command(&name).unwrap_throw();
        Uint8Array::from(cmd.atom().as_slice())
    }
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "Record<string, Command>", extends = js_sys::Object)]
    #[derive(Clone, Default, Debug)]
    pub type Commands;

    /// A helper to allow functions to take a `runtime?: Runtime` parameter.
    #[wasm_bindgen(typescript_type = "Runtime")]
    pub type OptionalRuntime;
}

impl OptionalRuntime {
    pub(crate) fn resolve(&self) -> Result<JsRuntime, Error> {
        let js_value: &JsValue = self.as_ref();

        if js_value.is_undefined() {
            Runtime::lazily_initialized().map(JsRuntime::from)
        } else {
            let rt = JsRuntime::try_from(js_value).expect_throw("Expected a runtime");
            Ok(rt)
        }
    }
}

impl Default for OptionalRuntime {
    fn default() -> Self {
        Self {
            obj: JsValue::UNDEFINED,
        }
    }
}

/// Execute a WASI module from TaskWasmRunProperties, calling `_start` directly.
///
/// This replaces wasmer_wasix::bin_factory::run_exec which cannot be used in the
/// JS WASM backend because:
/// 1. Host function errors (like proc_exit returning Err(WasiError::Exit(code)))
///    are thrown as JS exceptions via wasm_bindgen::throw_val
/// 2. The JS WebAssembly runtime re-wraps the exception as a generic
///    WebAssembly.RuntimeError, losing the typed Rust error info
/// 3. RuntimeError::downcast::<WasiError>() always fails, so run_exec's error
///    handling falls through to Errno::Noexec (45) for every exit
///
/// Custom WASI execution that replaces run_exec() for the JS backend.
///
/// run_exec() uses RuntimeError::downcast::<WasiError>() to extract exit codes,
/// which always fails in the JS WASM backend because the JS exception round-trip
/// loses Rust type info. This causes every exit to be reported as NOEXEC (45).
///
/// We replicate run_exec's logic but with JS-friendly error handling:
/// 1. bootstrap() for journal replay (no-op without journals)
/// 2. Call _start directly via try_clone_instance()
/// 3. Parse exit code from error message string when downcast fails
/// 4. blocking_on_exit for cleanup (safe with our wait_timeout(50ms) patch)
fn run_wasi_from_props(props: wasmer_wasix::runtime::task_manager::TaskWasmRunProperties) -> ExitCondition {
    use wasmer_wasix::WasiFunctionEnv;

    let ctx = props.ctx;
    let mut store = props.store;

    // Get _start from the instantiated module via try_clone_instance (public API).
    // In the JS backend, Instance::clone() is a JsValue reference copy — same
    // underlying JS WebAssembly.Instance as what run_exec would use.
    let start = match ctx.data(&store)
        .try_clone_instance()
        .and_then(|inst| inst.exports.get_function("_start").ok().cloned())
    {
        Some(f) => f,
        None => {
            web_sys::console::error_1(&"[deepwasm] run_wasi: _start not found".into());
            return ExitCondition::from_raw(1);
        }
    };

    // Track the thread for status updates.
    let thread = ctx.data(&store).thread.clone();
    thread.set_status_running();

    // Convert to WasiFunctionEnv for bootstrap() access (same as run_exec does).
    let ctx = WasiFunctionEnv { env: ctx.env };

    // Bootstrap the process (journal replay, etc). Must run on the same thread
    // as the WASM code. Without journals this is a no-op.
    match unsafe { ctx.bootstrap(&mut store) } {
        Ok(_rewind_state) => {
            // rewind_state is only used with journals; we ignore it.
        }
        Err(err) => {
            web_sys::console::error_1(
                &format!("[deepwasm] run_wasi: bootstrap failed: {err}").into(),
            );
            let exit_code = wasmer_wasix::wasmer_wasix_types::wasi::ExitCode::from(1u16);
            ctx.data(&store).blocking_on_exit(Some(exit_code));
            thread.set_status_finished(Err(err));
            return ExitCondition::from_raw(1);
        }
    }

    // Call _start. In WASI, proc_exit(N) propagates as Err(WasiError::Exit(N))
    // through the call stack, surfacing as a RuntimeError.
    let call_result = start.call(&mut store, &[]);

    // Extract the exit code from the result.
    let code: i32 = match &call_result {
        Ok(_) => 0,
        Err(err) => {
            // Try typed downcast first (works on native, fails on JS backend
            // because the JS exception round-trip loses Rust type info).
            match err.downcast_ref::<WasiError>() {
                Some(WasiError::Exit(code)) => code.raw() as i32,
                Some(WasiError::ThreadExit) => 0,
                _ => {
                    // JS backend fallback: parse exit code from error message.
                    // WasiError::Exit formats as "WASI exited with code: ExitCode::N"
                    // Currently the JS engine re-wraps this as a generic
                    // WebAssembly.RuntimeError, so parsing won't find a match.
                    parse_exit_code_from_message(&err.message()).unwrap_or(0)
                }
            }
        }
    };

    let exit_code = wasmer_wasix::wasmer_wasix_types::wasi::ExitCode::from(code as u16);

    // Run cleanup synchronously. With our patched virtual-mio (wait_timeout
    // instead of unbounded Condvar::wait), blocking_on_exit won't deadlock.
    // This ensures stdout/stderr are flushed before we return.
    ctx.data(&store).blocking_on_exit(Some(exit_code));

    // Mark thread as finished with the correct exit code.
    thread.set_status_finished(Ok(exit_code));

    ExitCondition::from_raw(code)
}

/// Parse an exit code from a RuntimeError message string.
///
/// In the JS WASM backend, WasiError::Exit(code) becomes a JS exception.
/// If the wasmer JS backend preserves the error message, it will contain
/// "WASI exited with code: ExitCode::N" wrapped as "js: WASI exited with...".
/// Currently the JS engine re-wraps it as "null function or function signature
/// mismatch", so this parser won't find a match, but it's kept as a fallback
/// for when the wasmer JS backend is fixed.
fn parse_exit_code_from_message(msg: &str) -> Option<i32> {
    let marker = "ExitCode::";
    let idx = msg.find(marker)?;
    let after = &msg[idx + marker.len()..];
    let num_str: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    num_str.parse().ok()
}

pub(crate) async fn configure_runner(
    options: &SpawnOptions,
    runner: &mut WasiRunner,
    runtime: &Runtime,
) -> Result<
    (
        Option<web_sys::WritableStream>,
        web_sys::ReadableStream,
        web_sys::ReadableStream,
    ),
    Error,
> {
    let args = options.parse_args()?;
    runner.with_args(args);

    let env = options.parse_env()?;
    runner.with_envs(env);

    tracing::debug!("Setting up CWD");
    if let Some(cwd) = options.parse_cwd()? {
        tracing::debug!("CWD FOUND {}", cwd);
        runner.with_current_dir(cwd);
    }

    for (dest, dir) in options.mounted_directories()? {
        runner.with_mount(dest, Arc::new(dir));
    }

    if let Some(uses) = options.uses() {
        let uses = crate::utils::js_string_array(uses)?;
        let packages = load_injected_packages(uses, runtime).await?;
        runner.with_injected_packages(packages);
    }

    let (stderr_pipe, stderr_stream) = crate::streams::output_pipe();
    runner.with_stderr(Box::new(stderr_pipe));

    let tty_options = runtime.tty_options().clone();
    match setup_tty(options, tty_options) {
        TerminalMode::Interactive {
            stdin_pipe,
            stdout_pipe,
            stdout_stream,
            stdin_stream,
        } => {
            tracing::debug!("Setting up interactive TTY");
            runner.with_stdin(Box::new(stdin_pipe));
            runner.with_stdout(Box::new(stdout_pipe));
            runtime.set_connected_to_tty(true);
            Ok((Some(stdin_stream), stdout_stream, stderr_stream))
        }
        TerminalMode::NonInteractive { stdin } => {
            tracing::debug!("Setting up non-interactive TTY");
            let (stdout_pipe, stdout_stream) = crate::streams::output_pipe();
            runner.with_stdin(Box::new(stdin));
            runner.with_stdout(Box::new(stdout_pipe));

            // HACK: Make sure we don't report stdin as interactive.  This
            // doesn't belong here because now it'll affect every other
            // instance sharing the same runtime... In theory, every
            // instance should get its own TTY state, but that's an issue
            // for wasmer-wasix to work out.
            runtime.set_connected_to_tty(false);

            Ok((None, stdout_stream, stderr_stream))
        }
    }
}

fn setup_tty(options: &SpawnOptions, tty_options: TtyOptions) -> TerminalMode {
    // Handle the simple (non-interactive) case first.
    if let Some(stdin) = options.read_stdin() {
        return TerminalMode::NonInteractive {
            stdin: virtual_fs::StaticFile::new(stdin),
        };
    }

    let (stdout_pipe, stdout_stream) = crate::streams::output_pipe();

    // Note: Because this is an interactive session, we want to intercept
    // stdin and let the TTY modify it.
    //
    // To do that, we manually copy data from the user's pipe into the TTY,
    // then the TTY modifies those bytes and writes them to the pipe we gave
    // to the runtime.
    //
    // To avoid confusing the pipes and how stdin data gets moved around,
    // here's a diagram:
    //
    //  ---------------------------------            --------------------          ----------------------------
    // | stdin_stream (user) u_stdin_rx | --copy--> | (tty) u_stdin_tx  | --pipe-> | stdin_pipe (runtime) ... |
    // ---------------------------------            --------------------          ----------------------------
    let (u_stdin_rx, stdin_stream) = crate::streams::input_pipe();
    let (u_stdin_tx, stdin_pipe) = Pipe::channel();

    let tty = Tty::new(
        Box::new(u_stdin_tx),
        Box::new(stdout_pipe.clone()),
        GlobalScope::current().is_mobile(),
        tty_options,
    );

    // FIXME: why would closing a clone actually close anything at all? Did the previous
    // implementation of pipe do things differently?

    // Because the TTY is manually copying between pipes, we need to make
    // sure the stdin pipe passed to the runtime is closed when the user
    // closes their end.
    let cleanup = {
        let mut stdin_pipe = stdin_pipe.clone();
        move || {
            tracing::debug!("Closing stdin");
            stdin_pipe.close();
        }
    };

    // Use the JS event loop to drive our manual user->tty copy
    wasm_bindgen_futures::spawn_local(
        copy_stdin_to_tty(u_stdin_rx, tty, cleanup)
            .in_current_span()
            .instrument(tracing::debug_span!("tty")),
    );

    TerminalMode::Interactive {
        stdin_pipe,
        stdout_pipe,
        stdout_stream,
        stdin_stream,
    }
}

fn copy_stdin_to_tty(
    mut u_stdin_rx: Pipe,
    mut tty: Tty,
    cleanup: impl FnOnce(),
) -> impl std::future::Future<Output = ()> {
    /// A RAII guard used to make sure the cleanup function always gets called.
    struct CleanupGuard<F: FnOnce()>(Option<F>);

    impl<F: FnOnce()> Drop for CleanupGuard<F> {
        fn drop(&mut self) {
            let cb = self.0.take().unwrap();
            cb();
        }
    }

    async move {
        let _guard = CleanupGuard(Some(cleanup));
        let mut buffer = BytesMut::new();

        loop {
            match u_stdin_rx.read_buf(&mut buffer).await {
                Ok(0) => {
                    break;
                }
                Ok(_) => {
                    // PERF: It'd be nice if we didn't need to do a copy here.
                    let data = buffer.to_vec();
                    tty = tty.on_event(wasmer_wasix::os::InputEvent::Raw(data)).await;
                    buffer.clear();
                }
                Err(e) => {
                    tracing::warn!(
                        error = &e as &dyn std::error::Error,
                        "Error reading stdin and copying it to the tty"
                    );
                    break;
                }
            }
        }
    }
}

#[derive(Debug)]
enum TerminalMode {
    Interactive {
        /// The [`Pipe`] used as the WASIX instance's stdin.
        stdin_pipe: Pipe,
        /// The [`Pipe`] used as the WASIX instance's stdout.
        stdout_pipe: Pipe,
        /// The [`ReadableStream`] our JavaScript caller will read stdout from.
        stdout_stream: ReadableStream,
        /// The [`WritableStream`] our JavaScript caller will write stdin to.
        stdin_stream: WritableStream,
    },
    NonInteractive {
        /// The file to use as the WASIX instance's stdin.
        stdin: virtual_fs::StaticFile,
    },
}

#[tracing::instrument(level = "debug", skip_all)]
async fn load_injected_packages(
    packages: Vec<String>,
    runtime: &Runtime,
) -> Result<Vec<BinaryPackage>, Error> {
    let futures: futures::stream::FuturesOrdered<_> = packages
        .into_iter()
        .map(|pkg| async move { load_package(&pkg, runtime).await })
        .collect();

    let packages = futures.try_collect().await?;

    Ok(packages)
}

#[tracing::instrument(level = "debug", skip(runtime))]
async fn load_package(pkg: &str, runtime: &Runtime) -> Result<BinaryPackage, Error> {
    let specifier: PackageSource = pkg.parse()?;
    let pkg = BinaryPackage::from_registry(&specifier, runtime).await?;

    Ok(pkg)
}

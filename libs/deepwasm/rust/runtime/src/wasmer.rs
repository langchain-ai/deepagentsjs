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
    runners::wasi::{WasiRunner, RuntimeOrEngine},
    VirtualTaskManager as _,
};
use web_sys::{ReadableStream, WritableStream};
use webc::{indexmap::IndexMap, metadata::Command as MetadataCommand};

use crate::{
    instance::ExitCondition,
    runtime::Runtime,
    tasks::ThreadPool,
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
        // Create a dedicated thread pool for this command, matching the
        // upstream wasmer-js pattern. A per-command pool ensures that
        // run_command's internal spawn_and_block_on (which uses blocking_recv)
        // works correctly on a dedicated web worker.
        let thread_pool = Arc::new(ThreadPool::new());
        let runtime = Arc::new(self.runtime.with_task_manager(thread_pool.clone()));
        let pkg = Arc::clone(&self.pkg);

        let options = options.unwrap_or_default();

        let mut runner = WasiRunner::new();
        let (stdin, stdout, stderr) = configure_runner(&options, &mut runner, &runtime).await?;
        let command_name = String::from(&self.name);

        tracing::debug!(%command_name, "Starting the WASI runner");

        let (sender, receiver) = oneshot::channel();

        // Run the command on a dedicated worker thread. WasiRunner::run_command
        // blocks until the process exits, properly connecting stdout/stderr
        // pipes through prepare_webc_env → builder.build() → spawn_exec.
        let pool_handle = thread_pool.clone();
        thread_pool.task_dedicated(Box::new(move || {
            let result = runner.run_command(&command_name, &pkg, RuntimeOrEngine::Runtime(runtime));
            let _ = sender.send(ExitCondition::from_result(result));
            pool_handle.close();
        }))?;

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

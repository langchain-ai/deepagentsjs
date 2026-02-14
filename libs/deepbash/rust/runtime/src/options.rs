use std::{collections::BTreeMap, sync::Arc};

use anyhow::Context;
use js_sys::Array;
use virtual_fs::TmpFileSystem;
use wasm_bindgen::{prelude::wasm_bindgen, JsCast, JsValue, UnwrapThrowExt};
use wasmer_wasix::WasiEnvBuilder;

use crate::{runtime::Runtime, utils::Error, Directory, DirectoryInit, JsRuntime, StringOrBytes};

#[wasm_bindgen]
extern "C" {
    /// A proxy for `Option<&Runtime>`.
    #[wasm_bindgen]
    pub(crate) type OptionalRuntime;

    #[wasm_bindgen]
    type OptionalDirectories;
}

#[wasm_bindgen(typescript_custom_section)]
const TYPE_DEFINITIONS: &'static str = r#"
/**
 * Common options used when running a WASIX program.
 */
type CommonOptions = {
    /** Additional command-line arguments to be passed to the program. */
    args?: string[];
    /** Environment variables to set. */
    env?: Record<string, string>;
    /** The standard input stream. */
    stdin?: string | Uint8Array;
    /**
     * Directories that should be mounted inside the WASIX instance.
     *
     * This maps mount locations to the {@link Directory} being mounted. As a
     * shortcut, if {@link DirectoryInit} is provided, a new {@link Directory}
     * will be instantiated and mounted.
     *
     * Avoid mounting directly to `"/"` as it may clobber a package's bundled
     * files.
     */
    mount?: Record<string, DirectoryInit | Directory>;
    /** The current working directory. */
    cwd?: string;
};

/**
 * Configuration used when starting a WASIX program with {@link runWasix}.
 */
export type RunOptions = CommonOptions & {
    /** The name of the program being run (passed in as arg 0) */
    program?: string;
    /**
     * The WASIX runtime to use.
     *
     * Providing a `Runtime` allows multiple WASIX instances to share things
     * like caches and threadpools. If not provided, a default `Runtime` will be
     * created.
     */
    runtime?: Runtime;
};

/**
 * Options used when running a command from a WASIX package with
 * {@link Command.run}.
 */
export type SpawnOptions = CommonOptions & {
    /**
     * Packages that should also be loaded into the WASIX environment.
     */
    uses?: string[];
}
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "CommonOptions", extends = js_sys::Object)]
    pub type CommonOptions;

    #[wasm_bindgen(method, getter)]
    fn cwd(this: &CommonOptions) -> Option<String>;

    #[wasm_bindgen(method, getter)]
    fn args(this: &CommonOptions) -> Option<Array>;

    #[wasm_bindgen(method, getter)]
    fn env(this: &CommonOptions) -> JsValue;

    #[wasm_bindgen(method, getter)]
    fn stdin(this: &CommonOptions) -> Option<StringOrBytes>;

    #[wasm_bindgen(method, getter)]
    fn mount(this: &CommonOptions) -> OptionalDirectories;
}

impl CommonOptions {
    pub(crate) fn parse_args(&self) -> Result<Vec<String>, Error> {
        match self.args() {
            Some(args) => crate::utils::js_string_array(args),
            None => Ok(Vec::new()),
        }
    }

    pub(crate) fn parse_cwd(&self) -> Result<Option<String>, Error> {
        match self.cwd() {
            Some(cwd) => Ok(Some(cwd)),
            None => Ok(None),
        }
    }

    pub(crate) fn parse_env(&self) -> Result<BTreeMap<String, String>, Error> {
        match self.env().dyn_ref() {
            Some(env) => {
                let vars = crate::utils::js_record_of_strings(env)?;
                Ok(vars.into_iter().collect())
            }
            None => Ok(BTreeMap::new()),
        }
    }

    pub(crate) fn read_stdin(&self) -> Option<Vec<u8>> {
        self.stdin().map(|s| s.as_bytes())
    }

    pub(crate) fn mounted_directories(&self) -> Result<Vec<(String, Directory)>, Error> {
        let Ok(obj) = self.mount().dyn_into::<js_sys::Object>() else {
            return Ok(Vec::new());
        };

        let entries: BTreeMap<js_sys::JsString, JsValue> = crate::utils::object_entries(&obj)?;
        let mut mounted_directories = Vec::new();

        for (key, value) in &entries {
            let key = String::from(key.clone());

            // Note: the value is a `Directory | DirectoryInit`

            let value = if let Ok(dir) = Directory::try_from(value) {
                dir
            } else if value.is_object() {
                // looks like we were given parameters for initializing a
                // Directory and need to call the constructor ourselves
                let init: &DirectoryInit = value.unchecked_ref();
                Directory::new(Some(init.clone()))?
            } else {
                unreachable!();
            };
            mounted_directories.push((key, value));
        }

        Ok(mounted_directories)
    }
}

impl Default for CommonOptions {
    fn default() -> Self {
        // Note: all fields are optional, so it's fine to use an empty object.
        CommonOptions {
            obj: js_sys::Object::new(),
        }
    }
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "RunOptions", extends = CommonOptions)]
    #[derive(Default)]
    pub type RunOptions;

    #[wasm_bindgen(method, getter)]
    pub(crate) fn program(this: &RunOptions) -> JsValue;

    #[wasm_bindgen(method, getter)]
    pub(crate) fn runtime(this: &RunOptions) -> OptionalRuntime;

}

impl RunOptions {
    /// Propagate any provided options to the [`WasiEnvBuilder`], returning
    /// streams that can be used for stdin/stdout/stderr.
    pub(crate) fn configure_builder(
        &self,
        builder: &mut WasiEnvBuilder,
    ) -> Result<
        (
            Option<web_sys::WritableStream>,
            web_sys::ReadableStream,
            web_sys::ReadableStream,
        ),
        Error,
    > {
        for arg in self.parse_args()? {
            builder.add_arg(arg);
        }

        for (key, value) in self.parse_env()? {
            builder.add_env(key, value);
        }

        let stdin = match self.read_stdin() {
            Some(stdin) => {
                let f = virtual_fs::StaticFile::new(stdin);
                builder.set_stdin(Box::new(f));
                None
            }
            None => {
                let (f, stdin) = crate::streams::input_pipe();
                builder.set_stdin(Box::new(f));
                Some(stdin)
            }
        };

        let (stdout_file, stdout) = crate::streams::output_pipe();
        builder.set_stdout(Box::new(stdout_file));

        let (stderr_file, stderr) = crate::streams::output_pipe();
        builder.set_stderr(Box::new(stderr_file));

        let fs = self.filesystem()?;
        builder.set_fs(Box::new(fs));
        builder.add_preopen_dir("/")?;

        Ok((stdin, stdout, stderr))
    }

    pub(crate) fn filesystem(&self) -> Result<TmpFileSystem, Error> {
        let root = TmpFileSystem::new();

        for (dest, fs) in self.mounted_directories()? {
            tracing::trace!(%dest, ?fs, "Mounting directory");

            let fs = Arc::new(fs) as Arc<_>;
            root.mount(dest.as_str().into(), &fs, "/".into())
                .with_context(|| format!("Unable to mount to \"{dest}\""))?;
        }

        tracing::trace!(?root, "Initialized the filesystem");

        Ok(root)
    }
}

impl OptionalRuntime {
    pub(crate) fn as_runtime(&self) -> Option<JsRuntime> {
        let js_value: &JsValue = self.as_ref();

        if js_value.is_undefined() {
            None
        } else {
            let rt = JsRuntime::try_from(js_value).expect_throw("Expected a runtime");
            Some(rt)
        }
    }

    /// Use [`OptionalRuntime::as_runtime()`] to resolve the instance, getting
    /// a reference to the global [`Runtime`] if one wasn't provided.
    pub(crate) fn resolve(&self) -> Result<JsRuntime, Error> {
        match self.as_runtime() {
            Some(rt) => Ok(rt),
            None => Runtime::lazily_initialized().map(JsRuntime::from),
        }
    }
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "SpawnOptions", extends = CommonOptions)]
    #[derive(Default)]
    pub type SpawnOptions;

    #[wasm_bindgen(method, getter)]
    pub(crate) fn command(this: &SpawnOptions) -> JsValue;

    #[wasm_bindgen(method, getter)]
    pub(crate) fn uses(this: &SpawnOptions) -> Option<js_sys::Array>;

    #[wasm_bindgen(method, getter)]
    pub(crate) fn runtime(this: &SpawnOptions) -> OptionalRuntime;
}

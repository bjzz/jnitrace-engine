
import { ReferenceManager } from "./utils/reference_manager";
import { Config } from "./utils/config";
import { ConfigBuilder } from "./utils/config_builder"

import { JNIEnvInterceptor } from "./jni/jni_env_interceptor";
import { JNIEnvInterceptorX86 } from "./jni/x86/jni_env_interceptor_x86";
import { JNIEnvInterceptorX64 } from "./jni/x64/jni_env_interceptor_x64";
import { JNIEnvInterceptorARM } from "./jni/arm/jni_env_interceptor_arm";
import { JNIEnvInterceptorARM64 } from "./jni/arm64/jni_env_interceptor_arm64";

import { JavaVMInterceptor } from "./jni/java_vm_interceptor";
import { JNIThreadManager } from "./jni/jni_thread_manager";

import { JNIInterceptorImpl} from "./api/jni_invocation_api";
import { JNILibraryWatcherImpl } from "./api/jni_invocation_api";
import { JNINativeReturnValue } from "./api/jni_invocation_api";
import { JNICallbackManager } from "./api/jni_invocation_api";
import { JNIInvocationCallback } from "./api/jni_invocation_api";

import { JNIMethod } from "./jni/jni_method";
import { JavaMethod } from "./utils/java_method";

const callbackManager : JNICallbackManager = new JNICallbackManager();

const JNIInterceptor = new JNIInterceptorImpl(callbackManager);
const JNILibraryWatcher = new JNILibraryWatcherImpl();

const JNI_ENV_INDEX = 0;
const JAVA_VM_INDEX = 0;
const LIB_TRACK_FIRST_INDEX = 0;

const threads = new JNIThreadManager();
const references = new ReferenceManager();

let jniEnvInterceptor: JNIEnvInterceptor | undefined = undefined;
if (Process.arch === "ia32") {
    jniEnvInterceptor = new JNIEnvInterceptorX86(
        references, threads, callbackManager
    );
} else if (Process.arch === "x64") {
    jniEnvInterceptor = new JNIEnvInterceptorX64(
        references, threads, callbackManager
    );
} else if (Process.arch === "arm") {
    jniEnvInterceptor = new JNIEnvInterceptorARM(
        references, threads, callbackManager
    );
} else if (Process.arch === "arm64") {
    jniEnvInterceptor = new JNIEnvInterceptorARM64(
        references, threads, callbackManager
    );
}

if (jniEnvInterceptor === undefined) {
    throw new Error(
        Process.arch + " currently unsupported, please file an issue."
    );
}

const javaVMInterceptor = new JavaVMInterceptor(
    references,
    threads,
    jniEnvInterceptor,
    callbackManager
);

jniEnvInterceptor.setJavaVMInterceptor(javaVMInterceptor);

let config: Config = Config.getInstance();
const trackedLibs: { [id: string]: boolean } = {};
const libBlacklist: { [id: string]: boolean } = {};


function checkLibrary(path: string): boolean {
    const EMPTY_ARRAY_LENGTH = 0;
    const ONE_ELEMENT_ARRAY_LENGTH = 1;
    const config = Config.getInstance();

    let willFollowLib = false;

    JNILibraryWatcher.doCallback(path);

    if (config.libraries.length === ONE_ELEMENT_ARRAY_LENGTH) {
        if (config.libraries[LIB_TRACK_FIRST_INDEX] === "*") {
            willFollowLib = true;
        }
    }

    if (!willFollowLib) {
        willFollowLib = config.libraries.filter(
            (l): boolean => path.includes(l)
        ).length > EMPTY_ARRAY_LENGTH;
    }

    return willFollowLib;
}

function interceptJNIOnLoad(jniOnLoadAddr: NativePointer): InvocationListener {
    return Interceptor.attach(jniOnLoadAddr, {
        onEnter(args): void {
            let shadowJavaVM = NULL;
            const javaVM = ptr(args[JAVA_VM_INDEX].toString());

            if (!threads.hasJavaVM()) {
                threads.setJavaVM(javaVM);
            }

            if (!javaVMInterceptor.isInitialised()) {
                shadowJavaVM = javaVMInterceptor.create();
            } else {
                shadowJavaVM = javaVMInterceptor.get();
            }

            args[JAVA_VM_INDEX] = shadowJavaVM;
        }
    });
}

function interceptJNIFunction(jniFunctionAddr: NativePointer): InvocationListener {
    return Interceptor.attach(jniFunctionAddr, {
        onEnter(args): void {
            if (jniEnvInterceptor === undefined) {
                return;
            }

            const threadId = this.threadId;
            const jniEnv = ptr(args[JNI_ENV_INDEX].toString());

            let shadowJNIEnv = NULL;

            threads.setJNIEnv(threadId, jniEnv);

            if (!jniEnvInterceptor.isInitialised()) {
                shadowJNIEnv = jniEnvInterceptor.create();
            } else {
                shadowJNIEnv = jniEnvInterceptor.get();
            }

            args[JNI_ENV_INDEX] = shadowJNIEnv;
        }
    });
}

const dlopenRef = Module.findExportByName(null, "dlopen");
const dlsymRef = Module.findExportByName(null, "dlsym");
const dlcloseRef = Module.findExportByName(null, "dlclose");

if (dlopenRef !== null && dlsymRef !== null && dlcloseRef !== null) {
    const HANDLE_INDEX = 0;

    const dlopen = new NativeFunction(dlopenRef, 'pointer', ['pointer', 'int']);
    Interceptor.replace(dlopen, new NativeCallback((filename, mode): NativeReturnValue => {
        const path = filename.readCString();
        const retval = dlopen(filename, mode);

        if (checkLibrary(path)) {
            trackedLibs[retval.toString()] = true;
        } else {
            libBlacklist[retval.toString()] = true;
        }
        return retval;
    }, 'pointer', ['pointer', 'int']));

    const dlsym = new NativeFunction(dlsymRef, "pointer", ["pointer", "pointer"]);
    Interceptor.attach(dlsym, {
        onEnter(args): void {
            const SYMBOL_INDEX = 1;

            this.handle = ptr(args[HANDLE_INDEX].toString());

            if (libBlacklist[this.handle]) {
                return;
            }

            this.symbol = args[SYMBOL_INDEX].readCString();
        },
        onLeave(retval): void {
            if (retval.isNull() || libBlacklist[this.handle]) {
                return;
            }

            const EMPTY_ARRAY_LEN = 0;

            if (config.includeExport.length > EMPTY_ARRAY_LEN) {
                const included = config.includeExport.filter(
                    (i): boolean => this.symbol.includes(i)
                );
                if (included.length === EMPTY_ARRAY_LEN) {
                    return;
                }
            }
            if (config.excludeExport.length > EMPTY_ARRAY_LEN) {
                const excluded = config.excludeExport.filter(
                    (e): boolean => this.symbol.includes(e)
                );
                if (excluded.length > EMPTY_ARRAY_LEN) {
                    return;
                }
            }

            if (trackedLibs[this.handle] === undefined) {
                // Android 7 and above miss the initial dlopen call.
                // Give it another chance in dlsym.
                const mod = Process.findModuleByAddress(retval);
                if (mod !== null && checkLibrary(mod.path)) {
                    trackedLibs[this.handle] = true;
                }
            }

            if (trackedLibs[this.handle] !== undefined) {
                const symbol = this.symbol;
                if (symbol === "JNI_OnLoad") {
                    interceptJNIOnLoad(ptr(retval.toString()));
                } else if (symbol.startsWith("Java_") === true) {
                    interceptJNIFunction(ptr(retval.toString()));
                }
            } else {
                let name = config.libraries[HANDLE_INDEX];

                if (name !== "*") {
                    const mod = Process.findModuleByAddress(retval);
                    if (mod === null) {
                        return;
                    }
                    name = mod.name;
                }

                if (config.libraries.includes(name) || name === "*") {
                    interceptJNIFunction(ptr(retval.toString()));
                }
            }
        }
    });

    const dlclose = new NativeFunction(dlcloseRef, "int", ["pointer"]);
    Interceptor.attach(dlclose, {
        onEnter(args): void {
            const handle = args[HANDLE_INDEX].toString();
            if (trackedLibs[handle]) {
                this.handle = handle;
            }
        },
        onLeave(retval): void {
            if (this.handle !== undefined) {
                if (retval.isNull()) {
                    delete trackedLibs[this.handle];
                }
            }
        }
    });
}

export { 
    JNIInterceptor,
    JNILibraryWatcher,
    JNINativeReturnValue,
    JNIMethod,
    JNIInvocationCallback,
    JavaMethod,
    Config,
    ConfigBuilder
};
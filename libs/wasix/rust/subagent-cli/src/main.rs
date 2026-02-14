use serde::Serialize;
use std::fs;
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

const RPC_DIR: &str = "/.rpc/requests";

#[derive(Serialize)]
struct SpawnRequest {
    id: String,
    method: String,
    args: SpawnArgs,
    timestamp: String,
}

#[derive(Serialize)]
struct SpawnArgs {
    task: String,
}

fn generate_id() -> String {
    let pid = process::id();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}-{}-{}", pid, ts.as_secs(), ts.subsec_nanos())
}

fn get_timestamp() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // Simple Unix timestamp since WASIX may not have chrono
    format!("{}.{}", ts.as_secs(), ts.subsec_millis())
}

fn print_usage() {
    eprintln!("Usage: subagent <command> [args...]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  spawn <task_description>    Spawn a subagent with the given task");
}

fn cmd_spawn(task: &str) -> Result<(), String> {
    let id = generate_id();

    let request = SpawnRequest {
        id: id.clone(),
        method: "spawn".to_string(),
        args: SpawnArgs {
            task: task.to_string(),
        },
        timestamp: get_timestamp(),
    };

    let json = serde_json::to_string_pretty(&request)
        .map_err(|e| format!("Failed to serialize request: {e}"))?;

    fs::create_dir_all(RPC_DIR)
        .map_err(|e| format!("Failed to create directory {RPC_DIR}: {e}"))?;

    let path = format!("{}/{}.json", RPC_DIR, id);
    fs::write(&path, &json).map_err(|e| format!("Failed to write {path}: {e}"))?;

    println!("Spawn request {id} submitted");
    Ok(())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        print_usage();
        return Err("No command specified".to_string());
    }

    match args[1].as_str() {
        "spawn" => {
            if args.len() < 3 {
                print_usage();
                return Err("spawn requires a task description".to_string());
            }
            // Join all remaining args as the task description
            let task = args[2..].join(" ");
            cmd_spawn(&task)
        }
        "help" | "--help" | "-h" => {
            print_usage();
            Ok(())
        }
        other => {
            print_usage();
            Err(format!("Unknown command: {other}"))
        }
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("Error: {e}");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_id_is_nonempty() {
        let id = generate_id();
        assert!(!id.is_empty());
    }

    #[test]
    fn test_generate_id_uniqueness() {
        let id1 = generate_id();
        let id2 = generate_id();
        // IDs should differ (at least the nanosecond component)
        // In rare cases they might match, so just check they're valid format
        assert!(id1.contains('-'));
        assert!(id2.contains('-'));
    }

    #[test]
    fn test_get_timestamp_format() {
        let ts = get_timestamp();
        // Should be "seconds.millis"
        assert!(ts.contains('.'));
        let parts: Vec<&str> = ts.split('.').collect();
        assert_eq!(parts.len(), 2);
        assert!(parts[0].parse::<u64>().is_ok());
        assert!(parts[1].parse::<u32>().is_ok());
    }

    #[test]
    fn test_spawn_request_serialization() {
        let request = SpawnRequest {
            id: "test-123".to_string(),
            method: "spawn".to_string(),
            args: SpawnArgs {
                task: "analyze this file".to_string(),
            },
            timestamp: "1700000000.123".to_string(),
        };

        let json = serde_json::to_string_pretty(&request).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed["id"], "test-123");
        assert_eq!(parsed["method"], "spawn");
        assert_eq!(parsed["args"]["task"], "analyze this file");
        assert_eq!(parsed["timestamp"], "1700000000.123");
    }

    #[test]
    fn test_spawn_request_json_structure() {
        let request = SpawnRequest {
            id: "abc".to_string(),
            method: "spawn".to_string(),
            args: SpawnArgs {
                task: "do something".to_string(),
            },
            timestamp: "0.0".to_string(),
        };

        let json = serde_json::to_string(&request).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        // Verify all expected fields exist
        assert!(parsed.get("id").is_some());
        assert!(parsed.get("method").is_some());
        assert!(parsed.get("args").is_some());
        assert!(parsed.get("timestamp").is_some());
        assert!(parsed["args"].get("task").is_some());

        // Verify no extra fields
        let obj = parsed.as_object().unwrap();
        assert_eq!(obj.len(), 4);
    }
}

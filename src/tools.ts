// Basic tools implementation for Deep Agents
export const writeTodos = {
  name: "writeTodos",
  description: "Create and manage a structured task list for tracking progress"
};

export const ls = {
  name: "ls", 
  description: "List contents of a directory"
};

export const readFile = {
  name: "readFile",
  description: "Read file contents from the filesystem"
};

export const writeFile = {
  name: "writeFile",
  description: "Write content to a file"
};

export const editFile = {
  name: "editFile",
  description: "Edit files with exact string replacement"
};

export const builtInTools = [
  writeTodos,
  ls,
  readFile,
  writeFile,
  editFile
];





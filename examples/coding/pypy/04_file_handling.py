# Python File Handling Tutorial

import os
import json
import csv
from pathlib import Path

# Basic file operations
def write_sample_file():
    # Writing to a file
    with open("sample.txt", "w") as file:
        file.write("Hello, World!\n")
        file.write("This is a sample file.\n")
        file.write("Learning Python file handling.\n")
    print("File 'sample.txt' created successfully!")

def read_sample_file():
    # Reading entire file
    try:
        with open("sample.txt", "r") as file:
            content = file.read()
            print("File content:")
            print(content)
    except FileNotFoundError:
        print("File not found!")

def read_file_lines():
    # Reading line by line
    try:
        with open("sample.txt", "r") as file:
            lines = file.readlines()
            print("Lines in file:")
            for i, line in enumerate(lines, 1):
                print(f"Line {i}: {line.strip()}")
    except FileNotFoundError:
        print("File not found!")

# Append to file
def append_to_file():
    with open("sample.txt", "a") as file:
        file.write("This line was appended!\n")
    print("Text appended to file!")

# Working with JSON
def json_operations():
    # Sample data
    data = {
        "name": "Alice",
        "age": 30,
        "hobbies": ["reading", "swimming", "coding"],
        "address": {
            "street": "123 Main St",
            "city": "Anytown",
            "zip": "12345"
        }
    }
    
    # Write JSON
    with open("data.json", "w") as file:
        json.dump(data, file, indent=2)
    print("JSON file created!")
    
    # Read JSON
    with open("data.json", "r") as file:
        loaded_data = json.load(file)
        print("Loaded JSON data:")
        print(f"Name: {loaded_data['name']}")
        print(f"Hobbies: {', '.join(loaded_data['hobbies'])}")

# Working with CSV
def csv_operations():
    # Sample data
    students = [
        ["Name", "Age", "Grade"],
        ["Alice", 20, "A"],
        ["Bob", 19, "B"],
        ["Charlie", 21, "A"],
        ["Diana", 20, "B+"]
    ]
    
    # Write CSV
    with open("students.csv", "w", newline="") as file:
        writer = csv.writer(file)
        writer.writerows(students)
    print("CSV file created!")
    
    # Read CSV
    with open("students.csv", "r") as file:
        reader = csv.reader(file)
        print("CSV content:")
        for row in reader:
            print(row)
    
    # Using DictWriter/DictReader
    student_dicts = [
        {"name": "Eve", "age": 22, "grade": "A"},
        {"name": "Frank", "age": 19, "grade": "B"},
    ]
    
    with open("students_dict.csv", "w", newline="") as file:
        fieldnames = ["name", "age", "grade"]
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(student_dicts)
    
    print("Dictionary CSV created!")

# File path operations with pathlib
def path_operations():
    current_dir = Path(".")
    print(f"Current directory: {current_dir.absolute()}")
    
    # Create directory
    new_dir = Path("test_folder")
    new_dir.mkdir(exist_ok=True)
    print(f"Directory created: {new_dir}")
    
    # Create file in directory
    file_path = new_dir / "test_file.txt"
    file_path.write_text("This is a test file in a subdirectory.")
    print(f"File created: {file_path}")
    
    # List files in directory
    print("Files in current directory:")
    for file in current_dir.iterdir():
        if file.is_file():
            print(f"  File: {file.name}")
        elif file.is_dir():
            print(f"  Directory: {file.name}")

# Error handling
def safe_file_operations():
    filename = "nonexistent.txt"
    
    try:
        with open(filename, "r") as file:
            content = file.read()
            print(content)
    except FileNotFoundError:
        print(f"Error: {filename} not found!")
    except PermissionError:
        print(f"Error: Permission denied for {filename}")
    except Exception as e:
        print(f"Unexpected error: {e}")
    finally:
        print("File operation completed.")

# File utilities
def file_info():
    filename = "sample.txt"
    if os.path.exists(filename):
        size = os.path.getsize(filename)
        print(f"File size: {size} bytes")
        
        import datetime
        mtime = os.path.getmtime(filename)
        modified_date = datetime.datetime.fromtimestamp(mtime)
        print(f"Last modified: {modified_date}")
    else:
        print(f"File {filename} does not exist")

# Main execution
if __name__ == "__main__":
    print("=== Python File Handling Tutorial ===\n")
    
    write_sample_file()
    read_sample_file()
    append_to_file()
    read_file_lines()
    
    print("\n=== JSON Operations ===")
    json_operations()
    
    print("\n=== CSV Operations ===")
    csv_operations()
    
    print("\n=== Path Operations ===")
    path_operations()
    
    print("\n=== Error Handling ===")
    safe_file_operations()
    
    print("\n=== File Info ===")
    file_info()
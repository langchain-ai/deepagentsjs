# Python Data Structures Tutorial

# Lists
fruits = ["apple", "banana", "orange", "grape"]
print(f"Fruits: {fruits}")
print(f"First fruit: {fruits[0]}")
print(f"Last fruit: {fruits[-1]}")

# List operations
fruits.append("mango")
fruits.insert(1, "kiwi")
print(f"After adding: {fruits}")

removed = fruits.pop()
print(f"Removed: {removed}, Remaining: {fruits}")

# List comprehension
numbers = [1, 2, 3, 4, 5]
squares = [x**2 for x in numbers]
even_squares = [x**2 for x in numbers if x % 2 == 0]
print(f"Squares: {squares}")
print(f"Even squares: {even_squares}")

# Tuples
coordinates = (10, 20)
rgb_color = (255, 128, 0)
print(f"Point: {coordinates}")
print(f"RGB: {rgb_color}")

# Tuple unpacking
x, y = coordinates
print(f"X: {x}, Y: {y}")

# Dictionaries
student = {
    "name": "John",
    "age": 20,
    "grade": "A",
    "subjects": ["Math", "Science", "English"]
}

print(f"Student: {student}")
print(f"Name: {student['name']}")
print(f"Age: {student.get('age', 'Unknown')}")

# Dictionary operations
student["email"] = "john@example.com"
student.update({"phone": "123-456-7890", "city": "New York"})
print(f"Updated: {student}")

# Sets
colors = {"red", "green", "blue", "red", "yellow"}
print(f"Colors: {colors}")  # Notice duplicates are removed

primary_colors = {"red", "green", "blue"}
warm_colors = {"red", "orange", "yellow"}

print(f"Union: {primary_colors | warm_colors}")
print(f"Intersection: {primary_colors & warm_colors}")
print(f"Difference: {primary_colors - warm_colors}")

# Working with nested structures
data = {
    "users": [
        {"name": "Alice", "scores": [85, 92, 78]},
        {"name": "Bob", "scores": [90, 87, 94]}
    ]
}

for user in data["users"]:
    avg_score = sum(user["scores"]) / len(user["scores"])
    print(f"{user['name']}'s average: {avg_score:.1f}")
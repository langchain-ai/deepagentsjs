# Python Basics Tutorial

# Variables and Data Types
name = "Alice"
age = 25
height = 5.6
is_student = True

print(f"Name: {name}, Age: {age}, Height: {height}, Student: {is_student}")

# Basic Operations
x = 10
y = 3
print(f"Addition: {x + y}")
print(f"Division: {x / y}")
print(f"Integer Division: {x // y}")
print(f"Modulo: {x % y}")
print(f"Power: {x ** y}")

# String Operations
greeting = "Hello"
world = "World"
message = greeting + " " + world + "!"
print(message)
print(message.upper())
print(message.lower())
print(f"Length: {len(message)}")

# Input from user
user_name = input("Enter your name: ")
print(f"Hello, {user_name}!")

# Conditional Statements
temperature = 25
if temperature > 30:
    print("It's hot!")
elif temperature > 20:
    print("It's warm!")
else:
    print("It's cool!")

# Loops
print("Numbers 1-5:")
for i in range(1, 6):
    print(i)

count = 0
while count < 3:
    print(f"Count: {count}")
    count += 1
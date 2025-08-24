# Python Functions Tutorial

# Basic function
def greet(name):
    return f"Hello, {name}!"

print(greet("Alice"))

# Function with default parameters
def introduce(name, age=25, city="Unknown"):
    return f"I'm {name}, {age} years old, from {city}"

print(introduce("Bob"))
print(introduce("Charlie", 30))
print(introduce("Diana", 28, "Paris"))

# Function with multiple return values
def calculate_stats(numbers):
    total = sum(numbers)
    average = total / len(numbers)
    maximum = max(numbers)
    minimum = min(numbers)
    return total, average, maximum, minimum

data = [10, 20, 30, 40, 50]
sum_val, avg_val, max_val, min_val = calculate_stats(data)
print(f"Sum: {sum_val}, Avg: {avg_val}, Max: {max_val}, Min: {min_val}")

# *args and **kwargs
def flexible_function(*args, **kwargs):
    print(f"Args: {args}")
    print(f"Kwargs: {kwargs}")
    
    total = sum(args)
    for key, value in kwargs.items():
        print(f"{key}: {value}")
    
    return total

result = flexible_function(1, 2, 3, 4, name="Alice", age=25)
print(f"Sum of args: {result}")

# Lambda functions
square = lambda x: x**2
add = lambda x, y: x + y

numbers = [1, 2, 3, 4, 5]
squared = list(map(square, numbers))
print(f"Squared: {squared}")

# Higher-order functions
def apply_operation(numbers, operation):
    return [operation(x) for x in numbers]

def double(x):
    return x * 2

def cube(x):
    return x ** 3

numbers = [1, 2, 3, 4, 5]
doubled = apply_operation(numbers, double)
cubed = apply_operation(numbers, cube)
print(f"Doubled: {doubled}")
print(f"Cubed: {cubed}")

# Decorators
def timer_decorator(func):
    import time
    def wrapper(*args, **kwargs):
        start = time.time()
        result = func(*args, **kwargs)
        end = time.time()
        print(f"{func.__name__} took {end - start:.4f} seconds")
        return result
    return wrapper

@timer_decorator
def slow_function():
    import time
    time.sleep(0.1)
    return "Done!"

result = slow_function()
print(result)

# Recursive function
def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)

def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

print(f"Factorial of 5: {factorial(5)}")
print(f"Fibonacci of 7: {fibonacci(7)}")

# Generator function
def countdown(n):
    while n > 0:
        yield n
        n -= 1

for num in countdown(5):
    print(f"Countdown: {num}")

# Generator expression
squares_gen = (x**2 for x in range(10))
print(f"First 5 squares: {list(squares_gen)[:5]}")
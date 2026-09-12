document.addEventListener("DOMContentLoaded", () => {

  const menuToggle = document.getElementById("menuToggle");
  const mainNav = document.getElementById("mainNav");

  if (menuToggle && mainNav) {

    menuToggle.addEventListener("click", () => {

      mainNav.classList.toggle("open");

      menuToggle.textContent =
        mainNav.classList.contains("open")
          ? "×"
          : "☰";

    });

  }

});
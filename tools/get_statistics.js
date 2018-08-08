"use strict";

let XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
let xhr = new XMLHttpRequest();

// 12299587 - latest v1.1.91
// let url = "https://api.github.com/repos/ProphetAlgorithms/zero-arizen/releases/12299909";
// 12299587 - v1.1.91
let url = "https://api.github.com/repos/ProphetAlgorithms/zero-arizen/releases/12299909";

xhr.open("GET", url, true);
xhr.onload = function () {
    let resp = JSON.parse(xhr.responseText);
    if (xhr.readyState === 4 && (xhr.status === "200")) {
        console.log(resp);
        for (let i = 0; i < resp["assets"].length; i++) {
            let obj = resp["assets"][i];
            console.log("Downloaded: " + obj["download_count"] + ", " + obj["name"]);
        }
    } else {
        console.error(resp);
    }
};

xhr.send(null);

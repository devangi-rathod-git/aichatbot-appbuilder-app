/* 
* <license header>
*/

import React from 'react'
import { NavLink } from 'react-router-dom'

function SideBar () {
    return (
        <ul className="SideNav">
            <li className="SideNav-item">
                <NavLink
                    className={({ isActive }) => `SideNav-itemLink ${isActive ? 'is-selected' : ''}`}
                    aria-current="page"
                    end
                    to="/"
                >
                    Settings
                </NavLink>
            </li>
            <li className="SideNav-item">
                <NavLink
                    className={({ isActive }) => `SideNav-itemLink ${isActive ? 'is-selected' : ''}`}
                    aria-current="page"
                    to="/syncproducts"
                >
                    Sync Products To VectorDB
                </NavLink>
            </li>
            <li className="SideNav-item">
                <NavLink
                    className={({ isActive }) => `SideNav-itemLink ${isActive ? 'is-selected' : ''}`}
                    aria-current="page"
                    to="/chat"
                >
                    Live Chat
                </NavLink>
            </li>
        </ul>
    )
}

export default SideBar
